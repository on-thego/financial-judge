import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const DART_BASE = "https://opendart.fss.or.kr/api";
const ANNUAL_REPORT = "11011";
const CACHE_SECONDS = 21600; // 6 hours

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
  const response = await fetch(url.toString());
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
  const response = await fetch(url.toString());
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
    const stockCode = String(item.stock_code ?? "").trim().padStart(6, "0");
    if (/^\d{6}$/.test(stockCode)) {
      map[stockCode] = {
        corp_code: String(item.corp_code ?? "").padStart(8, "0"),
        corp_name: String(item.corp_name ?? "")
      };
    }
  }

  const out = json(map);
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out.json();
}

async function resolveStock(stockCode, env, ctx) {
  const map = await fetchCorpMap(env, ctx);
  const company = map[stockCode];
  if (!company) throw new Error(`${stockCode} 종목코드를 DART에서 찾지 못했습니다.`);
  return { stock_code: stockCode, ...company };
}

function findAccount(items, patterns, sjDiv) {
  const pats = patterns.map(normText);
  const rows = sjDiv ? items.filter(x => x.sj_div === sjDiv) : items;
  for (const row of rows) {
    const name = normText(row.account_nm);
    if (pats.some(p => name === p || name.includes(p))) return row;
  }
  for (const row of rows) {
    const hay = normText(`${row.account_nm ?? ""} ${row.account_id ?? ""} ${row.account_detail ?? ""}`);
    if (pats.some(p => hay.includes(p))) return row;
  }
  return null;
}

function twoYears(row) {
  return {
    latest: cleanNumber(row?.thstrm_amount),
    previous: cleanNumber(row?.frmtrm_amount),
    latest_name: row?.thstrm_nm ?? null,
    previous_name: row?.frmtrm_nm ?? null
  };
}

function extractFinancials(items) {
  const revenue = findAccount(items, ["매출액", "수익(매출액)", "Revenue"], "IS");
  const netIncome = findAccount(items, [
    "당기순이익",
    "당기순이익(손실)",
    "지배기업의소유주에게귀속되는당기순이익",
    "ProfitLoss"
  ], "IS");
  const opIncome = findAccount(items, ["영업이익", "영업이익(손실)", "OperatingIncomeLoss"], "IS");
  const interest = findAccount(items, ["이자비용", "이자비용(금융원가)", "금융원가", "InterestExpense"], "IS");

  const opCF = findAccount(items, [
    "영업활동현금흐름",
    "영업활동으로인한현금흐름",
    "NetCashProvidedByUsedInOperatingActivities"
  ], "CF");
  const investCF = findAccount(items, [
    "투자활동현금흐름",
    "투자활동으로인한현금흐름",
    "NetCashProvidedByUsedInInvestingActivities"
  ], "CF");
  const financeCF = findAccount(items, [
    "재무활동현금흐름",
    "재무활동으로인한현금흐름",
    "NetCashProvidedByUsedInFinancingActivities"
  ], "CF");

  return {
    revenue: twoYears(revenue),
    net_income: twoYears(netIncome),
    operating_income: twoYears(opIncome),
    interest_expense: twoYears(interest),
    operating_cf: twoYears(opCF),
    investing_cf: twoYears(investCF),
    financing_cf: twoYears(financeCF)
  };
}

async function fetchAnnual(corpCode, env) {
  const now = new Date();
  // 2026년 9월 기준 일반적으로 최근 완료 연도는 2025년.
  // 데이터가 아직 없으면 1년 전까지 한 번 재시도.
  const firstYear = now.getUTCFullYear() - 1;
  for (const year of [firstYear, firstYear - 1]) {
    try {
      const data = await dartFetch("fnlttSinglAcntAll", {
        corp_code: corpCode,
        bsns_year: year,
        reprt_code: ANNUAL_REPORT,
        fs_div: "CFS"
      }, env);
      if (Array.isArray(data.list) && data.list.length) {
        return { year, items: data.list };
      }
    } catch (_) {}
  }
  throw new Error("최근 연차 연결재무제표를 찾지 못했습니다.");
}

async function fetchLargestShareholder(corpCode, year, env) {
  for (const y of [year, year - 1]) {
    try {
      const data = await dartFetch("hyslrSttus", {
        corp_code: corpCode,
        bsns_year: y,
        reprt_code: ANNUAL_REPORT
      }, env);
      const items = Array.isArray(data.list) ? data.list : [];
      if (!items.length) continue;

      // 최대주주 현황 API의 기말 지분율 중 가장 큰 단일 주주를 "대주주 지분율"로 사용.
      // 관련인 합산이 필요한 별도 정의를 원할 경우 후속 확장 가능.
      let best = null;
      for (const item of items) {
        const pct = cleanNumber(item.trmend_posesn_stock_qota_rt);
        if (pct !== null && (!best || pct > best.pct)) {
          best = {
            name: item.nm ?? null,
            relation: item.relate ?? null,
            pct
          };
        }
      }
      return {
        year: y,
        as_of: items[0].stlm_dt ?? null,
        pct: best?.pct ?? null,
        holder: best
      };
    } catch (_) {}
  }
  return { year: null, as_of: null, pct: null, holder: null };
}

function judge(fin, shareholder) {
  const revenueOk =
    fin.revenue.latest !== null &&
    fin.revenue.previous !== null &&
    fin.revenue.latest > fin.revenue.previous;

  const niLatest = fin.net_income.latest;
  const niPrev = fin.net_income.previous;
  const netIncomeOk = !(niLatest !== null && niPrev !== null && niLatest < 0 && niPrev < 0);

  const ocfOk = fin.operating_cf.latest !== null && fin.operating_cf.latest > 0;
  const icfOk = fin.investing_cf.latest !== null && fin.investing_cf.latest < 0;
  const fcfOk = fin.financing_cf.latest !== null && fin.financing_cf.latest < 0;

  const opIncome = fin.operating_income.latest;
  const interest = fin.interest_expense.latest;
  const coverage = opIncome !== null && interest !== null && interest !== 0
    ? opIncome / interest
    : null;
  const coverageOk = coverage !== null && coverage >= 1;

  const ownership = shareholder.pct;
  const ownershipOk = ownership !== null && ownership >= 20;

  const results = [
    ["revenue_growth", "매출액 증가", revenueOk, `최근 ${format(fin.revenue.latest)} / 전년 ${format(fin.revenue.previous)}`, "최근년도 매출 > 전년도 매출"],
    ["net_income", "당기순이익 2개년 연속 적자", netIncomeOk, `최근 ${format(fin.net_income.latest)} / 전년 ${format(fin.net_income.previous)}`, "2개년 연속 음수이면 불량"],
    ["operating_cf", "영업활동 현금흐름", ocfOk, format(fin.operating_cf.latest), "영업활동 현금흐름 > 0"],
    ["investing_cf", "투자활동 현금흐름", icfOk, format(fin.investing_cf.latest), "투자활동 현금흐름 < 0"],
    ["financing_cf", "재무활동 현금흐름", fcfOk, format(fin.financing_cf.latest), "재무활동 현금흐름 < 0"],
    ["interest_coverage", "이자보상배율", coverageOk, coverage === null ? "데이터 없음" : `${format(coverage)}배`, "영업이익 / 이자비용 ≥ 1.0"],
    ["largest_shareholder", "대주주 지분율", ownershipOk, ownership === null ? "데이터 없음" : `${format(ownership)}%`, "대주주 지분율 ≥ 20.0%"]
  ].map(([key, label, ok, value, rule]) => ({
    key, label, status: ok ? "양호" : "불량", value, rule
  }));

  return {
    results,
    score: results.filter(x => x.status === "양호").length,
    total: results.length,
    derived: {
      interest_coverage: coverage,
      largest_shareholder_pct: ownership
    }
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
  return {
    ...company,
    report_year: annual.year,
    financials,
    largest_shareholder: shareholder,
    judgement: judge(financials, shareholder)
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

        const results = [];
        for (const code of codes) {
          try {
            const item = await analyzeOne(code, env, ctx);
            results.push({ ok: true, ...item });
          } catch (error) {
            results.push({ ok: false, stock_code: code, corp_name: code, error: error?.message || String(error) });
          }
        }

        return json({
          ok: true,
          results,
          analyzed_at: new Date().toISOString()
        });
      }

      // 프론트엔드 정적 파일 제공
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, message: error?.message || String(error) }, 500);
    }
  }
};
