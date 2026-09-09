export async function readApiResponse(response) {
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    let message;
    if (response.status === 401) message = 'Your session has expired. Sign in again to continue.';
    else if (response.status === 403) message = 'You do not have access to this action. Ask the group owner for help.';
    else if (response.status === 429) message = 'Too many requests. Wait a moment, then try again.';
    else if (response.status >= 500) message = 'We could not connect to Probable. Please try again in a moment.';
    else if (Array.isArray(data?.detail)) {
      message = data.detail.map(issue => `${issue.loc?.at(-1) || 'Field'}: ${issue.msg || 'Check this value'}`).join('. ');
    } else message = typeof data?.detail === 'string' ? data.detail : 'We could not complete that request. Please try again.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (data === null) throw new Error('Probable returned an unexpected response. Please try again.');
  return data;
}
