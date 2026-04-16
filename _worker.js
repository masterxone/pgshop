#!/usr/bin/env node

const MAX_REQUESTS = 150;
const WINDOW_MS = 15 * 1000;
const CACHE_TTL_MS = 15 * 1000;
const BLOCK_DURATION_MS = 5 * 60 * 1000;

const mutationCache = {};
const inFlightRequests = {};
const requestCounts = {};
const blockedIPs = {};

const EXTERNAL_API_URL = "https://app.orderkuota.com:443/api/v2/get";
const EXTERNAL_LOGIN_URL = "https://app.orderkuota.com:443/api/v2/login";
const EXTERNAL_API_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "Accept-Encoding": "gzip",
  "User-Agent": "okhttp/4.12.0"
};

const APP_REG_ID = "cBSh2sQfTYijaiEFwJVn0j:APA91bHGtsVACRZKT9gykfsB1jpWselIyEpPlbKqNHz_Qvpqvq8DO9a8SiBndgaQ7C_3xgAktQ_6AIyAOS4NKB964vZzqVjSZ5JGtTQLN88naiTfhUaQhms";
const APP_VERSION_CODE = "250711";
const APP_VERSION_NAME = "25.07.11";

function getClientIP(request) {
  return request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (blockedIPs[ip] && blockedIPs[ip] > now) {
    const timeLeftSeconds = Math.ceil((blockedIPs[ip] - now) / 1000);
    return { blocked: true, timeLeft: timeLeftSeconds };
  }
  if (blockedIPs[ip]) delete blockedIPs[ip];
  const windowStart = now - WINDOW_MS;
  requestCounts[ip] = (requestCounts[ip] || []).filter(t => t > windowStart);
  requestCounts[ip].push(now);
  if (requestCounts[ip].length > MAX_REQUESTS) {
    blockedIPs[ip] = now + BLOCK_DURATION_MS;
    return { blocked: true, timeLeft: 300 };
  }
  return { blocked: false };
}

async function fetchExternalMutasi(username, token) {
  const userId = token.split(":")[0];
  const MUTASI_URL = `https://app.orderkuota.com/api/v2/qris/mutasi/${userId}`;

  const DATA1 = `app_reg_id=${APP_REG_ID}&phone_android_version=15&app_version_code=${APP_VERSION_CODE}&phone_uuid=cBSh2sQfTYijaiEFwJVn0j&auth_username=${encodeURIComponent(username)}&requests[1]=qris_menu&auth_token=${encodeURIComponent(token)}&app_version_name=${APP_VERSION_NAME}&ui_mode=light&requests[0]=account&phone_model=2312DRA50G`;

  const res1 = await fetch(EXTERNAL_API_URL, {
    method: "POST",
    headers: EXTERNAL_API_HEADERS,
    body: DATA1
  });
  await res1.text();

  await scheduler.wait(1000);

  const DATA2 = `app_reg_id=${APP_REG_ID}&phone_uuid=cBSh2sQfTYijaiEFwJVn0j&phone_model=2312DRA50G&requests[qris_history][keterangan]=&requests[qris_history][jumlah]=&request_time=${Date.now()}&phone_android_version=15&app_version_code=250811&auth_username=${encodeURIComponent(username)}&requests[qris_history][page]=1&auth_token=${encodeURIComponent(token)}&app_version_name=25.08.11&ui_mode=light&requests[0]=account&requests[qris_history][dari_tanggal]=&requests[qris_history][ke_tanggal]=`;

  const res2 = await fetch(MUTASI_URL, {
    method: "POST",
    headers: EXTERNAL_API_HEADERS,
    body: DATA2
  });

  const result2 = await res2.json();
  return result2?.qris_history?.results || [];
}

async function handleApiRequest(request) {
  const ip = getClientIP(request);
  const rl = checkRateLimit(ip);

  if (rl.blocked) {
    return Response.json({
      success: false,
      message: `Terlalu banyak request. IP Anda diblokir sementara. Silakan coba lagi dalam ${rl.timeLeft} detik.`,
      ip
    }, { status: 429 });
  }

  const formData = await request.formData();
  const username = formData.get("username");
  const token = formData.get("token");

  if (!username || !token) {
    return Response.json({ success: false, message: "Username dan token diperlukan." }, { status: 400 });
  }

  const cacheKey = `${username}:${token}`;
  const now = Date.now();
  const cacheEntry = mutationCache[cacheKey];

  if (cacheEntry && (now - cacheEntry.timestamp) < CACHE_TTL_MS) {
    return Response.json({
      results: cacheEntry.data,
      source: "cache",
      cached_at: new Date(cacheEntry.timestamp).toISOString()
    });
  }

  if (inFlightRequests[cacheKey]) {
    try {
      const freshResults = await inFlightRequests[cacheKey];
      return Response.json({
        results: freshResults,
        source: "locked_wait_success",
        cached_at: new Date(mutationCache[cacheKey].timestamp).toISOString()
      });
    } catch (_) {}
  }

  const apiCallPromise = (async () => {
    try {
      const results = await fetchExternalMutasi(username, token);
      mutationCache[cacheKey] = { data: results, timestamp: Date.now() };
      return results;
    } finally {
      delete inFlightRequests[cacheKey];
    }
  })();

  inFlightRequests[cacheKey] = apiCallPromise;

  try {
    const freshResults = await apiCallPromise;
    return Response.json({
      results: freshResults,
      source: "external_api_creator",
      cached_at: new Date(mutationCache[cacheKey].timestamp).toISOString()
    });
    
  } catch (error) {
    if (cacheEntry) {
      return Response.json({
        results: cacheEntry.data,
        source: "stale_cache_fallback",
        message: "Gagal memperbarui data dari API eksternal, mengembalikan data cache lama.",
        cached_at: new Date(cacheEntry.timestamp).toISOString()
      });
    }
    return Response.json({ success: false, message: `Internal error: ${error.message}` }, { status: 500 });
  }
}

async function handleLogin(request) {
  const ip = getClientIP(request);
  const rl = checkRateLimit(ip);

  if (rl.blocked) {
    return Response.json({
      success: false,
      message: `Terlalu banyak request. IP Anda diblokir sementara. Silakan coba lagi dalam ${rl.timeLeft} detik.`,
      ip
    }, { status: 429 });
  }

  const formData = await request.formData();
  const username = formData.get("username");
  const password = formData.get("password");

  if (!username || !password) {
    return Response.json({ success: false, message: "Username dan password diperlukan." }, { status: 400 });
  }

  const payload = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&app_reg_id=${APP_REG_ID}&app_version_code=${APP_VERSION_CODE}&app_version_name=${APP_VERSION_NAME}`;

  try {
    const res = await fetch(EXTERNAL_LOGIN_URL, {
      method: "POST",
      headers: EXTERNAL_API_HEADERS,
      body: payload
    });
    
    const data = await res.json();
    return Response.json(data);
  } catch (error) {
    return Response.json({ success: false, message: `Login error: ${error.message}` }, { status: 500 });
  }
}

async function handleVerifyOtp(request) {
  const ip = getClientIP(request);
  const rl = checkRateLimit(ip);

  if (rl.blocked) {
    return Response.json({
      success: false,
      message: `Terlalu banyak request. IP Anda diblokir sementara. Silakan coba lagi dalam ${rl.timeLeft} detik.`,
      ip
    }, { status: 429 });
  }

  const formData = await request.formData();
  const username = formData.get("username");
  const otp = formData.get("otp");

  if (!username || !otp) {
    return Response.json({ success: false, message: "Username dan OTP diperlukan." }, { status: 400 });
  }

  const payload = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(otp)}&app_reg_id=${APP_REG_ID}&app_version_code=${APP_VERSION_CODE}&app_version_name=${APP_VERSION_NAME}`;

  try {
    const res = await fetch(EXTERNAL_LOGIN_URL, {
      method: "POST",
      headers: EXTERNAL_API_HEADERS,
      body: payload
    });
    const data = await res.json();
    return Response.json(data);
  } catch (error) {
    return Response.json({ success: false, message: `OTP error: ${error.message}` }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/orderkuota' && request.method === 'POST') {
      return handleApiRequest(request);
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request);
    }

    if (url.pathname === '/api/verify-otp' && request.method === 'POST') {
      return handleVerifyOtp(request);
    }

    if (url.pathname === '/') {
      const indexRequest = new Request(url.origin + '/public/index.html', {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      return env.ASSETS.fetch(indexRequest);
    }

    const newUrl = new URL(url);
    newUrl.pathname = '/public' + url.pathname;

    const newRequest = new Request(newUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });

    return env.ASSETS.fetch(newRequest);
  }
}
