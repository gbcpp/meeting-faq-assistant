function createPrivacyFilter(secrets) {
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const protectedValues = [...new Set(secrets.filter(value => typeof value === 'string' && value.trim())
    .flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]))]
    .sort((a, b) => b.length - a.length);
  const credentialValue = /((?:"?(?:password|token|api[_ -]?key|authorization|cookie)"?)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi;
  const bearerValue = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
  const prefixedToken = /\b(?:glsa_|sk-)[a-z0-9_-]{8,}\b/gi;

  const filter = value => {
    let text = String(value);
    for (const secret of protectedValues) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    return text
      .replace(credentialValue, '$1[REDACTED]')
      .replace(bearerValue, '$1[REDACTED]')
      .replace(prefixedToken, '[REDACTED]');
  };

  const sanitize = (value, key = '') => {
    if (/password|token|api[_-]?key|authorization|cookie/i.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return filter(value);
    if (Array.isArray(value)) return value.map(item => sanitize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
    }
    return value;
  };

  return {
    filter,
    sanitize,
  };
}

function agentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^VICTORIALOGS_(?:PASSWORD|TOKEN|NETRC_FILE)$/i.test(key)));
}

module.exports = { createPrivacyFilter, agentEnvironment };
