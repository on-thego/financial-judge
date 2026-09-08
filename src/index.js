import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const DART_BASE = "https://opendart.fss.or.kr/api";
const ANNUAL_REPORT = "11011";
const CACHE_SECONDS = 21600; // 6 hours

const DART_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "*/*",
  Referer: "https://opendart.fss.or.kr/",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\D/g, "").padStart(6, "0");
}

function cleanNumber(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim().replaceAll(",", "");
  if (!s || ["-", "–", "—", "N/A", "nan"].includes(s)) return null;
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);
  s = s.replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normText(value) {
  return String(value ?? "").replace(/[\s\u00a0]/g, "").toLowerCase();
}

async function dartFetch(endpoint, params, env) {
  const url = new URL(`${DART_BASE}/${endpoint}.json`);
  const all = { ...params, crtfc_key: env.DART_API_KEY };
  Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url.toString(), { headers: DART_FETCH_HEADERS });
  if (!response.ok) throw new Error(`DART HTTP ${response.status}`);
  const data = await response.json();
  if (String(data.status) !== "000") {
    throw new Error(`DART ${data.status}: ${data.message || "API 오류"}`);
  }
  return data;
}

async function fetchCorpMap(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://financial-judge.local/_corp_code_map");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${DART_BASE}/corpCode.xml`);
  url.searchParams.set("crtfc_key", env.DART_API_KEY);
  const response = await fetch(url.toString(), { headers: DART_FETCH_HEADERS });
  if (!response.ok) throw new Error(`corpCode HTTP ${response.status}`);
  const buf = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(buf);
  const xmlEntry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith(".xml"));
  if (!xmlEntry) throw new Error("DART 기업코드 XML을 찾지 못했습니다.");

  const xml = strFromU8(xmlEntry[1]);
  const parser = new XMLParser({ ignoreAttributes: true });
  const parsed = parser.parse(xml);
  const list = Array.isArray(parsed?.result?.list)
    ? parsed.result.list
    : parsed?.result?.list
      ? [parsed.result.list]
      : [];

  const map = {};
  for (const item of list) {
    const stockCode = String(item.stock_code ?? "").trim();
    if (stockCode && stockCode !== "") {
      map[normalizeCode(stockCode)] = {
        corp_code: String(item.corp_code ?? "").trim(),
        corp_name: String(item.corp_name ?? "").trim(),
      };
    }
  }

  const payload = JSON.stringify(map);
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(payload, {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${CACHE_SECONDS}`,
        },
      })
    )
  );
  return map;
}

async function resolveStock(stockCode, env, ctx) {
  const map = await fetchCorpMap(env, ctx);
  const code = normalizeCode(stockCode);
  const info = map[code];
  if (!info) throw new Error(`종목코드 ${code}에 해당하는 기업을 DART에서 찾을 수 없습니다.`);
  return { stock_code: code, ...info };
}

async function fetchAnnual(corpCode, env) {
  const now = new Date();
  const thisYear = now.getFullYear();

  for (const year of [thisYear, thisYear - 1, thisYear - 2]) {
    try {
      const data = await dartFetch("fnlttSinglAcntAll", {
        corp_code: corpCode,
        bsns_year: String(year),
        reprt_code: ANNUAL_REPORT,
        fs_div: "CFS",
      }, env);
      if (data?.list?.length) return { year, items: data.list };
    } catch (e) {
      // try CFS -> OFS fallback, then older year
      try {
        const data = await dartFetch("fnlttSinglAcntAll", {
          corp_code: corpCode,
          bsns_year: String(year),
          reprt_code: ANNUAL_REPORT,
          fs_div: "OFS",
        }, env);
        if (data?.list?.length) return { year, items: data.list };
      } catch (e2) {
        continue;
      }
    }
  }
  throw new Error("최근 3개년 사업보고서 재무제표를 찾을 수 없습니다.");
}

async function fetchLargestShareholder(corpCode, year, env) {
  try {
    const data = await dartFetch("hyslrSttus", {
      corp_code: corpCode,
      bsns_year: String(year),
      reprt_code: ANNUAL_REPORT,
    }, env);
    const list = data?.list || [];
    let best = null;
    for (const row of list) {
      const ratio = cleanNumber(row.trmend_posesn_stock_qota_rt);
      if (ratio === null) continue;
      if (!best || ratio > best.ratio) {
        best = { name: row.nm || row.stockhold_qota_rt_nm || "-", ratio };
      }
    }
    return best;
  } catch (e) {
    return null;
  }
}

function extractFinancials(items) {
  const byAccount = (names, sjDiv) => {
    for (const item of items) {
      if (sjDiv && item.sj_div !== sjDiv) continue;
      const nm = normText(item.account_nm);
      if (names.some((n) => nm.includes(normText(n)))) {
        return {
          curr: cleanNumber(item.thstrm_amount),
          prev: cleanNumber(item.frmtrm_amount),
        };
      }
    }
    return { curr: null, prev: null };
  };

  const revenue = byAccount(["매출액", "수익(매출액)", "영업수익"], "IS");
  const netIncome = byAccount(["당기순이익", "당기순이익(손실)"], "IS");
  const operatingCF = byAccount(["영업활동으로인한현금흐름", "영업활동현금흐름"], "CF");
  const investingCF = byAccount(["투자활동으로인한현금흐름", "투자활동현금흐름"], "CF");
  const financingCF = byAccount(["재무활동으로인한현금흐름", "재무활동현금흐름"], "CF");
  const interestExpense = byAccount(["이자비용"], "IS");
  const operatingIncome = byAccount(["영업이익", "영업이익(손실)"], "IS");

  let interestCoverage = null;
  if (operatingIncome.curr !== null && interestExpense.curr) {
    interestCoverage = operatingIncome.curr / Math.abs(interestExpense.curr);
  }

  return {
    revenue,
    netIncome,
    operatingCF,
    investingCF,
    financingCF,
    interestCoverage,
  };
}

function judge(financials, shareholder) {
  const revenueGrowth = financials.revenue.curr !== null && financials.revenue.prev !== null
    ? financials.revenue.curr > financials.revenue.prev
    : null;
  const netIncomeOk = financials.netIncome.curr !== null ? financials.netIncome.curr >= 0 : null;
  const operatingCFOk = financials.operatingCF.curr !== null ? financials.operatingCF.curr > 0 : null;
  const investingCFOk = financials.investingCF.curr !== null ? financials.investingCF.curr < 0 : null;
  const financingCFOk = financials.financingCF.curr !== null ? financials.financingCF.curr < 0 : null;
  const interestCoverageOk = financials.interestCoverage !== null ? financials.interestCoverage >= 1.0 : null;
  const shareholderOk = shareholder ? shareholder.ratio >= 20.0 : null;

  // 판정 기준 순서: 매출, 순이익, 영업CF, 투자CF, 재무CF, 이자보상, 대주주
  const results = [revenueGrowth, netIncomeOk, operatingCFOk, investingCFOk, financingCFOk, interestCoverageOk, shareholderOk];
  const nonNull = results.filter(v => v !== null);
  const passed = nonNull.filter(v => v === true).length;
  const total = nonNull.length;
  const score = total ? `${passed}/${total}` : "N/A";

  return {
    results,
    score,
    passed,
    total,
    // 개별 필드는 호환성을 위해 유지 (프론트엔드에서 사용하지 않을 수 있음)
    revenueGrowth,
    netIncomeOk,
    operatingCFOk,
    investingCFOk,
    financingCFOk,
    interestCoverageOk,
    shareholderOk,
  };
}

function format(v) {
  if (v === null || v === undefined) return "데이터 없음";
  return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

async function analyzeOne(stockCode, env, ctx) {
  const company = await resolveStock(stockCode, env, ctx);
  const annual = await fetchAnnual(company.corp_code, env);
  const financials = extractFinancials(annual.items);
  const shareholder = await fetchLargestShareholder(company.corp_code, annual.year, env);
  const judgement = judge(financials, shareholder);
  return {
    ok: true,
    ...company,
    report_year: annual.year,
    financials,
    largest_shareholder: shareholder,
    judgement,
  };
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DART_API_KEY) {
        return json({ ok: false, message: "Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다." }, 500);
      }

      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({ ok: true, service: "financial-judge" });
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        const body = await request.json();
        const raw = Array.isArray(body.stock_codes) ? body.stock_codes : [];
        const codes = [...new Set(raw.map(normalizeCode).filter(x => /^\d{6}$/.test(x)))].slice(0, 10);

        if (!codes.length) {
          return json({ ok: false, message: "분석할 6자리 종목코드를 입력하세요." }, 400);
        }

        const results = await Promise.all(
          codes.map(async (code) => {
            try {
              return await analyzeOne(code, env, ctx);
            } catch (e) {
              return { ok: false, stock_code: code, error: e.message || String(e) };
            }
          })
        );

        return json({ ok: true, results });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ ok: false, message: e.message || String(e) }, 500);
    }
  },
};
