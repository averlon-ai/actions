import * as core from '@actions/core';
import { ProxyAgent, type Dispatcher } from 'undici';

type ProxyEnv = NodeJS.ProcessEnv;

function isAnyProxyEnvSet(env: ProxyEnv = process.env): boolean {
  return Boolean(env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy);
}

export function shouldBypassProxy(hostname: string, env: ProxyEnv = process.env): boolean {
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (!noProxy) {
    return false;
  }

  const normalizedHost = hostname.toLowerCase();
  return noProxy.split(',').some(entry => {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) {
      return false;
    }
    if (pattern === '*') {
      return true;
    }

    const hostPattern = pattern.startsWith('[')
      ? pattern.slice(1, pattern.indexOf(']'))
      : pattern.split(':')[0];
    if (hostPattern.startsWith('.')) {
      return normalizedHost === hostPattern.slice(1) || normalizedHost.endsWith(hostPattern);
    }

    return normalizedHost === hostPattern || normalizedHost.endsWith(`.${hostPattern}`);
  });
}

export function proxyForUrl(targetUrl: URL, env: ProxyEnv = process.env): URL | null {
  if (shouldBypassProxy(targetUrl.hostname, env)) {
    return null;
  }

  const proxyValue =
    targetUrl.protocol === 'https:'
      ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
      : env.HTTP_PROXY || env.http_proxy;
  if (!proxyValue) {
    return null;
  }

  const normalizedProxyValue = /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyValue)
    ? proxyValue
    : `http://${proxyValue}`;
  return new URL(normalizedProxyValue);
}

export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username) {
      url.username = '***';
    }
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '(invalid proxy url)';
  }
}

export function logProxyConfiguration(env: ProxyEnv = process.env): void {
  if (!isAnyProxyEnvSet(env)) {
    return;
  }

  core.debug(
    [
      'HTTP proxy environment detected for Averlon API requests',
      env.HTTP_PROXY || env.http_proxy
        ? `http_proxy=${redactProxyUrl(String(env.HTTP_PROXY || env.http_proxy))}`
        : 'http_proxy=(unset)',
      env.HTTPS_PROXY || env.https_proxy
        ? `https_proxy=${redactProxyUrl(String(env.HTTPS_PROXY || env.https_proxy))}`
        : 'https_proxy=(unset)',
      env.NO_PROXY || env.no_proxy
        ? `no_proxy=${env.NO_PROXY || env.no_proxy}`
        : 'no_proxy=(unset)',
    ].join('; ')
  );
}

export function logProxyRouting(requestUrl: string, env: ProxyEnv = process.env): void {
  if (!isAnyProxyEnvSet(env)) {
    return;
  }

  const targetUrl = new URL(requestUrl);
  const proxyUrl = proxyForUrl(targetUrl, env);
  if (proxyUrl) {
    core.debug(`Averlon API request to ${targetUrl.hostname} routed via proxy`);
    return;
  }

  if (shouldBypassProxy(targetUrl.hostname, env)) {
    core.debug(`Averlon API request to ${targetUrl.hostname} bypasses proxy (NO_PROXY match)`);
  }
}

export function createProxyDispatcherForUrl(
  requestUrl: string,
  env: ProxyEnv = process.env
): Dispatcher | undefined {
  const proxyUrl = proxyForUrl(new URL(requestUrl), env);
  if (!proxyUrl) {
    return undefined;
  }

  return new ProxyAgent(proxyUrl.toString());
}
