import os
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend import main as api


class Query:
    def __init__(self, rows):
        self.rows = deepcopy(rows)
        self.negate = False

    def select(self, *args, **kwargs):
        return self

    def eq(self, key, value):
        self.rows = [row for row in self.rows if row.get(key) == value]
        return self

    def in_(self, key, values):
        self.rows = [row for row in self.rows if row.get(key) in values]
        return self

    @property
    def not_(self):
        self.negate = True
        return self

    def is_(self, key, value):
        self.rows = [row for row in self.rows if (row.get(key) is None) != self.negate]
        self.negate = False
        return self

    def limit(self, value):
        self.rows = self.rows[:value]
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class ProductionApiTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "APP_ENV": "production", "ALLOW_DEV_AUTH_BYPASS": "true",
            "SUPABASE_URL": "https://qa.supabase.co", "FRONTEND_BASE_URL": "https://qa.example",
            "SUPABASE_SERVICE_ROLE_KEY": "", "SUPABASE_KEY": "", "VITE_SUPABASE_PUBLISHABLE_KEY": "",
        })
        self.env.start()
        self.client = TestClient(api.app)

    def tearDown(self):
        self.client.close()
        self.env.stop()

    def test_development_headers_never_authenticate_in_production(self):
        with patch.object(api, "get_db") as db:
            response = self.client.post('/api/groups', headers={"X-Probable-Dev-User": "attacker"}, json={"name": "QA", "members": ["QA"]})
        self.assertEqual(response.status_code, 401)
        db.assert_not_called()

    def test_every_api_write_requires_auth_before_database_work(self):
        cases = [('/api/groups', {}), ('/api/markets/rules/draft', {}), ('/api/markets/odds/seed', {}),
                 ('/api/markets/test/trade', {}), ('/api/predictors/pl-2026-27/entry', {}),
                 ('/api/brackets/wc26-bracket-r32/entry', {}), ('/api/invites/test/join', {})]
        with patch.object(api, "get_db") as db:
            for path, payload in cases:
                with self.subTest(path=path):
                    self.assertEqual(self.client.post(path, json=payload).status_code, 401)
        db.assert_not_called()

    def test_anonymous_group_listing_does_not_read_private_groups(self):
        with patch.object(api, "get_db") as db:
            response = self.client.get('/api/groups?members=Dave&include=private-group')
        self.assertEqual(response.json(), {"groups": []})
        db.assert_not_called()

    def test_include_parameter_cannot_expand_membership_access(self):
        db = MagicMock()
        db.table.return_value = Query([{"user_id": "owner", "group_id": "own"}])
        group = {"id": "own", "createdByUserId": "owner", "memberRecords": []}
        with patch.object(api, 'get_db', return_value=db), patch.object(api, 'load_all_groups', return_value=[group]) as load:
            result = api.groups_response(user_id="owner", include="other")
        self.assertEqual([g['id'] for g in result['groups']], ['own'])
        self.assertEqual(load.call_args.kwargs['allowed_group_ids'], ['own'])
        self.assertEqual(load.call_count, 1)

    def test_public_market_context_removes_accounts_and_positions(self):
        group = {"id": "private", "name": "Friends", "members": ["Dave"], "memberRecords": [{"userId": "secret"}],
                 "balances": {"Dave": 123}, "markets": [{"id": "m", "probability": .5, "positions": {"Dave": 20},
                 "eventTrades": [{"userId": "secret"}], "trades": [{"userId": "secret"}]}]}
        with patch.object(api, 'load_market_context_group', return_value=group):
            response = self.client.get('/api/markets/m/context')
        public = response.json()['group']
        self.assertEqual(public['balances'], {})
        self.assertEqual(public['members'], [])
        self.assertEqual(public['markets'][0]['positions'], {})
        self.assertEqual(public['markets'][0]['eventTrades'], [])
        self.assertEqual(group['balances'], {'Dave': 123})

    def test_prediction_name_lookup_returns_only_public_submissions(self):
        for submitted in [None, '2026-08-01T00:00:00Z']:
            row = {'id': 'entry', 'challenge_id': 'pl-2026-27', 'participant': 'QA', 'user_email': 'private@example.test',
                   'user_id': 'private-user', 'submitted_at': submitted, 'ranking': []}
            db = MagicMock()
            db.table.return_value = Query([row])
            with patch.object(api, 'get_db', return_value=db):
                entry = self.client.get('/api/predictors/pl-2026-27/entry?participant=QA').json()['entry']
            if submitted:
                self.assertNotIn('userEmail', entry)
                self.assertNotIn('userId', entry)
            else:
                self.assertIsNone(entry)

    def test_shared_bracket_never_exposes_email_or_drafts(self):
        for submitted in [None, '2026-08-01T00:00:00Z']:
            db = MagicMock()
            db.table.return_value = Query([{'id': 'entry', 'challenge_id': 'wc26-bracket-r32', 'user_email': 'private@example.test',
                                           'user_id': 'private-user', 'submitted_at': submitted}])
            with patch.object(api, 'get_db', return_value=db):
                result = self.client.get('/api/brackets/wc26-bracket-r32/entry?entry=entry').json()['entry']
            if submitted:
                self.assertNotIn('userEmail', result)
                self.assertNotIn('userId', result)
            else:
                self.assertIsNone(result)

    def test_readiness_requires_a_database_credential(self):
        with patch.dict(os.environ, {'APP_ENV': 'development', 'SUPABASE_URL': 'https://example.supabase.co',
                                    'SUPABASE_SERVICE_ROLE_KEY': '', 'SUPABASE_KEY': '', 'VITE_SUPABASE_PUBLISHABLE_KEY': ''}):
            response = self.client.get('/api/ready')
        self.assertEqual(response.status_code, 503)
        self.assertTrue(response.json()['issues'])
        self.assertEqual(response.headers['cache-control'], 'no-store')

    def test_readiness_does_not_expose_database_exception_details(self):
        with patch.dict(os.environ, {'SUPABASE_SERVICE_ROLE_KEY': 'test', 'ALLOW_DEV_AUTH_BYPASS': 'false'}), patch.object(api, 'get_db', side_effect=RuntimeError('credential-secret')):
            response = self.client.get('/api/ready')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('credential-secret', response.text)

    def test_readiness_checks_the_schema_rpc(self):
        db = MagicMock()
        with patch.dict(os.environ, {'SUPABASE_SERVICE_ROLE_KEY': 'test', 'ALLOW_DEV_AUTH_BYPASS': 'false'}), patch.object(api, 'get_db', return_value=db):
            response = self.client.get('/api/ready')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['issues'], [])
        db.rpc.assert_called_once_with('probable_production_readiness', {})

    def test_group_leaderboard_requires_identity(self):
        with patch.object(api, 'get_db') as db:
            self.assertEqual(self.client.get('/api/groups/private/challenges/pl-2026-27/leaderboard').status_code, 401)
        db.assert_not_called()

    def test_no_basket_calls_one_atomic_rpc(self):
        db = MagicMock()
        db.rpc.return_value.execute.return_value.data = {'basket': True}
        payload = api.TradeCreate(participant='forged', side='no', amount=5, outcomeId='no')
        actor = api.AuthIdentity('00000000-0000-0000-0000-000000000001', 'QA')
        self.assertEqual(api.place_complement_event_trade(db, {'id': 'event'}, [], 'no', payload, actor), {'basket': True})
        db.table.assert_not_called()
        self.assertEqual(db.rpc.call_args.args[1]['p_user_id'], actor.user_id)

    def test_subcent_and_nonfinite_trades_are_rejected(self):
        for amount in [.001, 0, -1, float('nan'), float('inf')]:
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                api.TradeCreate(participant='QA', side='yes', amount=amount)

    def test_market_image_cannot_escape_the_public_directory(self):
        with patch.object(api, 'require_event_or_outcome', return_value=({'image_url': '/../.env.local'}, None)):
            response = self.client.get('/api/markets/image-test/image')
        self.assertEqual(response.status_code, 404)


if __name__ == '__main__':
    unittest.main()
