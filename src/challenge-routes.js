export const DEFAULT_PREDICTOR_ID = "pl-2026-27";

export const LEAGUE_PREDICTOR_LIST = [
  {
    id: "pl-2026-27",
    route: "/premier-league-predictor",
    leagueName: "Premier League",
    leagueMark: "PL",
    logoUrl: "/league-logos/premier-league-dark.png",
    title: "Premier League",
    season: "2026/27",
    lockAt: "2026-09-01T03:59:00+00:00",
    clubCount: 20,
  },
  {
    id: "laliga-2026-27",
    route: "/la-liga-predictor",
    leagueName: "La Liga",
    leagueMark: "LALIGA",
    logoUrl: "/league-logos/la-liga.png",
    title: "La Liga",
    season: "2026/27",
    lockAt: "2026-09-01T03:59:00+00:00",
    clubCount: 20,
  },
  {
    id: "serie-a-2026-27",
    route: "/serie-a-predictor",
    leagueName: "Serie A",
    leagueMark: "SERIE A",
    logoUrl: "/league-logos/serie-a-dark.png",
    title: "Serie A",
    season: "2026/27",
    lockAt: "2026-09-01T03:59:00+00:00",
    clubCount: 20,
  },
  {
    id: "bundesliga-2026-27",
    route: "/bundesliga-predictor",
    leagueName: "Bundesliga",
    leagueMark: "BUNDESLIGA",
    logoUrl: "/league-logos/bundesliga-dark.png",
    title: "Bundesliga",
    season: "2026/27",
    lockAt: "2026-09-01T03:59:00+00:00",
    clubCount: 18,
  },
  {
    id: "ligue-1-2026-27",
    route: "/ligue-1-predictor",
    leagueName: "Ligue 1",
    leagueMark: "LIGUE 1",
    logoUrl: "/league-logos/ligue-1.png",
    title: "Ligue 1",
    season: "2026/27",
    lockAt: "2026-09-01T03:59:00+00:00",
    clubCount: 18,
  },
];

export const LEAGUE_PREDICTOR_ROUTES = Object.fromEntries(
  LEAGUE_PREDICTOR_LIST.map(predictor => [predictor.id, predictor]),
);
