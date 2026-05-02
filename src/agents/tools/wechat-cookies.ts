import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logDebug, logWarn } from "../../logger.js";

// mp.weixin.qq.com flags every CVM datacenter IP with a 「环境异常」 CAPTCHA wall.
// Once the CAPTCHA has been solved manually inside a Chrome session on the CVM
// (see /Users/ruida/wechat-cookie-bootstrap/gw2-wechat.sh), the Network domain's
// poc_sid cookie issued by mp.weixin.qq.com lets plain HTTP requests from the
// same CVM bypass the wall — typically for ~30 days. We read that cookie jar
// off disk and inject a Cookie header into every mp.weixin.qq.com fetch.

const COOKIE_FILE = join(homedir(), ".openclaw", "wechat-cookies.txt");

// Use the Linux Chrome UA that matches what we used to solve the CAPTCHA on the
// CVM. Some bot-protection systems bind the bypass cookie to the UA.
export const WECHAT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

interface ParsedCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number; // unix seconds, 0 = session cookie
  name: string;
  value: string;
}

interface CachedJar {
  mtimeMs: number;
  cookies: ParsedCookie[];
}

let cached: CachedJar | null = null;

function parseNetscapeCookies(content: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const parts = rawLine.split("\t");
    if (parts.length < 7) {
      continue;
    }
    const [domain, incSub, path, secure, expires, name, ...valueParts] = parts;
    if (!domain || !name) {
      continue;
    }
    out.push({
      domain,
      includeSubdomains: incSub?.toUpperCase() === "TRUE",
      path: path || "/",
      secure: secure?.toUpperCase() === "TRUE",
      expires: Number.parseInt(expires ?? "0", 10) || 0,
      name,
      value: valueParts.join("\t"),
    });
  }
  return out;
}

function loadJar(): ParsedCookie[] {
  let stat;
  try {
    stat = statSync(COOKIE_FILE);
  } catch {
    return [];
  }
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.cookies;
  }
  try {
    const content = readFileSync(COOKIE_FILE, "utf8");
    const cookies = parseNetscapeCookies(content);
    cached = { mtimeMs: stat.mtimeMs, cookies };
    logDebug(`[wechat-cookies] loaded ${cookies.length} cookie(s) from ${COOKIE_FILE}`);
    return cookies;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`[wechat-cookies] failed to read ${COOKIE_FILE}: ${message}`);
    return [];
  }
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const cookieHost = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  if (host === cookieHost) {
    return true;
  }
  if (cookieDomain.startsWith(".") && host.endsWith(`.${cookieHost}`)) {
    return true;
  }
  return false;
}

function pathMatches(cookiePath: string, urlPath: string): boolean {
  if (urlPath === cookiePath) {
    return true;
  }
  if (urlPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) {
      return true;
    }
    return urlPath.charAt(cookiePath.length) === "/";
  }
  return false;
}

export function isWechatHost(host: string): boolean {
  return host === "mp.weixin.qq.com" || host.endsWith(".mp.weixin.qq.com");
}

export function getWechatCookieHeader(targetUrl: URL): string | undefined {
  if (!isWechatHost(targetUrl.hostname)) {
    return undefined;
  }
  const jar = loadJar();
  if (jar.length === 0) {
    return undefined;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const matched = jar.filter((c) => {
    if (!domainMatches(c.domain, targetUrl.hostname)) {
      return false;
    }
    if (!pathMatches(c.path, targetUrl.pathname || "/")) {
      return false;
    }
    if (c.secure && targetUrl.protocol !== "https:") {
      return false;
    }
    if (c.expires > 0 && c.expires < nowSec) {
      return false;
    }
    return true;
  });
  if (matched.length === 0) {
    return undefined;
  }
  return matched.map((c) => `${c.name}=${c.value}`).join("; ");
}
