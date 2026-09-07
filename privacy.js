function createPrivacyFilter(secrets) {
  const compact = text => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const protectedValues = secrets.filter(value => typeof value === 'string' && value.trim())
    .flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')])
    .map(compact);
  const internal = /jrtc[-_\s]*faq|\bskills?\b|skill\.md|agents\.md|VICTORIALOGS_|netrc|authorization|bearer\s|(?:password|token|api[_ -]?key|cookie)\s*[=:]|glsa_[a-z0-9_]+/i;
  const isSensitive = value => {
    const text = String(value);
    const normalized = compact(text);
    return internal.test(text) || internal.test(normalized) || protectedValues.some(secret => normalized.includes(secret));
  };
  return {
    isSensitive,
    filter: text => isSensitive(text) ? '回复包含内部配置或敏感信息，已隐藏。请仅查询会议与质量信息。' : text,
  };
}

function agentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^VICTORIALOGS_/i.test(key)));
}

module.exports = { createPrivacyFilter, agentEnvironment };
