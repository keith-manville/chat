const UA = 'ctf-slack-clone';
const GH_API = 'https://api.github.com';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
}

function parseRepo(repoSlug) {
  if (!repoSlug || !repoSlug.includes('/')) {
    throw new Error('repo must be "owner/name"');
  }
  const [owner, name] = repoSlug.split('/', 2);
  if (!owner || !name) throw new Error('repo must be "owner/name"');
  return { owner, name };
}

async function listJsonFiles({ repo, ref = 'main', path = 'scenarios', token }) {
  if (!token) throw new Error('token required');
  const { owner, name } = parseRepo(repo);
  const url = `${GH_API}/repos/${owner}/${name}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) throw new Error(`Path not found: ${repo}@${ref}:${path}`);
  if (res.status === 401) throw new Error('GitHub auth failed (401). Check the PAT scope (Contents: read).');
  if (!res.ok) throw new Error(`GitHub list failed: ${res.status} ${await res.text()}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error(`Path is not a directory: ${path}`);
  return items.filter((i) => i.type === 'file' && i.name.toLowerCase().endsWith('.json'));
}

async function fetchFile({ repo, ref = 'main', filePath, token }) {
  if (!token) throw new Error('token required');
  const { owner, name } = parseRepo(repo);
  const url = `${GH_API}/repos/${owner}/${name}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`GitHub fetch ${filePath} failed: ${res.status}`);
  const data = await res.json();
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new Error(`Unexpected response for ${filePath}`);
  }
  const text = Buffer.from(data.content, 'base64').toString('utf8');
  return { text, sha: data.sha, path: data.path };
}

/**
 * Pulls every *.json file under `path` from the configured repo/ref,
 * parses each, and returns a normalized list ready to upsert.
 *
 * Each scenario file may use either of these shapes:
 *   { name, description?, briefing?, definition: { personas, events } }
 *   { name, description?, briefing?, personas?, events? }
 *
 * Returns: [{ name, description, briefing, definition, sourceRef, sourceSha, errors? }]
 */
async function pullScenarios({ repo, ref = 'main', path = 'scenarios', token }) {
  const items = await listJsonFiles({ repo, ref, path, token });
  const out = [];
  for (const item of items) {
    try {
      const { text, sha, path: filePath } = await fetchFile({
        repo,
        ref,
        filePath: item.path,
        token,
      });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        out.push({ ok: false, path: filePath, error: `JSON parse: ${err.message}` });
        continue;
      }
      const definition = parsed.definition
        ? parsed.definition
        : { personas: parsed.personas || [], events: parsed.events || [] };
      const sourceRef = `${repo}@${ref}:${filePath}`;
      out.push({
        ok: true,
        path: filePath,
        sourceRef,
        sourceSha: sha,
        scenario: {
          name: parsed.name || filePath.replace(/^.*\//, '').replace(/\.json$/i, ''),
          description: parsed.description || '',
          briefing: parsed.briefing || '',
          definition,
        },
      });
    } catch (err) {
      out.push({ ok: false, path: item.path, error: err.message });
    }
  }
  return out;
}

module.exports = { pullScenarios, parseRepo };
