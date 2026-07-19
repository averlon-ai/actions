import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as core from '@actions/core';
import {
  createProxyDispatcherForUrl,
  logProxyRouting,
  proxyForUrl,
  redactProxyUrl,
  shouldBypassProxy,
} from '../../src/http-proxy';

const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

describe('http-proxy', () => {
  afterEach(() => {
    for (const key of PROXY_ENV_VARS) {
      delete process.env[key];
    }
  });

  describe('shouldBypassProxy', () => {
    it('matches exact hostnames and domain suffixes', () => {
      process.env['NO_PROXY'] = 'localhost,127.0.0.1,.internal.corp';

      expect(shouldBypassProxy('localhost')).toBe(true);
      expect(shouldBypassProxy('api.internal.corp')).toBe(true);
      expect(shouldBypassProxy('wfe.prod.averlon.io')).toBe(false);
    });

    it('matches wildcard no_proxy entries', () => {
      process.env['NO_PROXY'] = '*';
      expect(shouldBypassProxy('anything.example.com')).toBe(true);
    });

    it('handles host:port entries in no_proxy', () => {
      process.env['NO_PROXY'] = 'localhost:8080';
      expect(shouldBypassProxy('localhost')).toBe(true);
      expect(shouldBypassProxy('example.com')).toBe(false);
    });
  });

  describe('proxyForUrl', () => {
    it('returns null when no proxy env vars are set', () => {
      expect(proxyForUrl(new URL('https://wfe.prod.averlon.io/'))).toBeNull();
    });

    it('uses HTTPS_PROXY for https targets with HTTP_PROXY fallback', () => {
      process.env['HTTP_PROXY'] = 'http://fallback.example.com:8080';
      process.env['HTTPS_PROXY'] = 'http://secure-proxy.example.com:8443';

      expect(proxyForUrl(new URL('https://wfe.prod.averlon.io/')).toString()).toBe(
        'http://secure-proxy.example.com:8443/'
      );
    });

    it('falls back to HTTP_PROXY for https targets when HTTPS_PROXY is unset', () => {
      process.env['HTTP_PROXY'] = 'http://fallback.example.com:8080';

      expect(proxyForUrl(new URL('https://wfe.prod.averlon.io/')).toString()).toBe(
        'http://fallback.example.com:8080/'
      );
    });

    it('uses HTTP_PROXY only for http targets', () => {
      process.env['HTTP_PROXY'] = 'http://http-proxy.example.com:8080';
      process.env['HTTPS_PROXY'] = 'http://secure-proxy.example.com:8443';

      expect(proxyForUrl(new URL('http://wfe.prod.averlon.io/')).toString()).toBe(
        'http://http-proxy.example.com:8080/'
      );
    });

    it('normalizes proxy values without a scheme', () => {
      process.env['HTTP_PROXY'] = 'proxy.example.com:8080';

      expect(proxyForUrl(new URL('https://wfe.prod.averlon.io/')).toString()).toBe(
        'http://proxy.example.com:8080/'
      );
    });

    it('returns null when host matches NO_PROXY', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
      process.env['NO_PROXY'] = 'wfe.dev.averlon.io';

      expect(proxyForUrl(new URL('https://wfe.dev.averlon.io/'))).toBeNull();
    });
  });

  describe('redactProxyUrl', () => {
    it('redacts credentials from proxy URLs', () => {
      expect(redactProxyUrl('http://user:secret@proxy.example.com:8080')).toBe(
        'http://***:***@proxy.example.com:8080/'
      );
    });
  });

  describe('createProxyDispatcherForUrl', () => {
    it('returns undefined when proxy env vars are not set', () => {
      expect(createProxyDispatcherForUrl('https://wfe.prod.averlon.io/')).toBeUndefined();
    });

    it('returns a dispatcher when HTTP_PROXY is set', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';

      expect(createProxyDispatcherForUrl('https://wfe.prod.averlon.io/')).toBeDefined();
    });
  });

  describe('logProxyRouting', () => {
    it('logs direct routing when host matches NO_PROXY', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
      process.env['NO_PROXY'] = 'wfe.dev.averlon.io';

      const debugSpy = spyOn(core, 'debug').mockImplementation(() => {});

      logProxyRouting('https://wfe.dev.averlon.io/pb.Auth/AuthenticateAPIKey');

      expect(debugSpy).toHaveBeenCalledWith(
        'Averlon API request to wfe.dev.averlon.io bypasses proxy (NO_PROXY match)'
      );

      debugSpy.mockRestore();
    });

    it('logs proxied routing when host does not match NO_PROXY', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';

      const debugSpy = spyOn(core, 'debug').mockImplementation(() => {});

      logProxyRouting('https://wfe.prod.averlon.io/pb.Auth/AuthenticateAPIKey');

      expect(debugSpy).toHaveBeenCalledWith(
        'Averlon API request to wfe.prod.averlon.io routed via proxy'
      );

      debugSpy.mockRestore();
    });
  });
});
