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

// JSON API 전용 - 리다이렉트 및 Content-Type 검증
async function dartFetch(endpoint, params, env) {
  const url = new URL(`${DART_BASE}/${endpoint}.json`);
  const all = { ...params, crtfc_key: env.DART_API_KEY };
  Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v));

  const response = await fetch(url.toString(), { redirect: "manual" });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "알 수 없음";
    throw new Error(`DART 리다이렉트 발생 (${response.status}): ${location}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DART HTTP ${response.status}: ${text.substring(0, 200)}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`DART non-JSON 응답 (${contentType}): ${text.substring(0, 200)}`);
  }
  const data = await response.json();
  if (String(data.status) !== "000") {
    throw new Error(`DART ${data.status}: ${data.message || "API 오류"}`);
  }
  return data;
}

// ========== 수정된 fetchCorpMap ==========
// - redirect: "manual" 적용
// - HTML(error1.html) 응답을 감지하여 명확한 오류 메시지 반환
async function fetchCorpMap(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://financial-judge.local/_corp_code_map");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${DART_BASE}/corpCode.xml`);
  url.searchParams.set("crtfc_key", env.DART_API_KEY);

  // 리다이렉트를 수동으로 처리하여 무한 루프 방지
  const response = await fetch(url.toString(), { redirect: "manual" });

  // 리다이렉트 감지
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "알 수 없음";
    throw new Error(`DART corpCode 리다이렉트 (${response.status}): ${location}`);
  }

  // HTTP 오류
  if (!response.ok) {
    throw new Error(`corpCode HTTP ${response.status}`);
  }

  // Content-Type이 HTML인 경우 -> 인증키 오류 또는 잘못된 요청
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    // error1.html 등이 반환된 경우
    throw new Error(
      "DART 인증키 오류 또는 잘못된 요청으로 HTML 페이지가 반환되었습니다. API 키를 다시 확인해주세요."
    );
  }

  // ZIP 파일 처리 (XML 포함)
  const buf = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(buf);
  const xmlEntry = Object.entries(files).find(([name]) =>
    name.toLowerCase().endsWith(".xml")
  );
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
        corp_name: String(item.corp_name ?? ""),
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
  const company = map[code];
  if (!company) throw new Error(`${code} 종목코드를 DART에서 찾지 못했습니다.`);
  return { stock_code: code, ...company };
}

// ========== 재무제표 항목 추출 ==========
function findAccount(items, patterns, sjDiv) {
  const pats = patterns.map(normText);
  const rows = sjDiv ? items.filter((x) => x.sj_div === sjDiv) : items;
  for (const row of rows) {
    const name = normText(row.account_nm);
    if (pats.some((p) => name === p || name.includes(p))) return row;
  }
  for (const row of rows) {
    const hay = normText(
      `${row.account_nm ?? ""} ${row.account_id ?? ""} ${row.account_detail ?? ""}`
    );
    if (pats.some((p) => hay.includes(p))) return row;
  }
  return null;
}

function twoYears(row) {
  return {
    latest: cleanNumber(row?.thstrm_amount),
    previous: cleanNumber(row?.frmtrm_amount),
    latest_name: row?.thstrm_nm ?? null,
    previous_name: row?.frmtrm_nm ?? null,
  };
}

function extractFinancials(items) {
  const revenue = findAccount(items, ["매출액", "수익(매출액)", "Revenue"], "IS");
  const netIncome = findAccount(
    items,
    [
      "당기순이익",
      "당기순이익(손실)",
      "지배기업의소유주에게귀속되는당기순이익",
      "ProfitLoss",
    ],
    "IS"
  );
  const opIncome = findAccount(
    items,
    ["영업이익", "영업이익(손실)", "OperatingIncomeLoss"],
    "IS"
  );
  const interest = findAccount(
    items,
    ["이자비용", "이자비용(금융원가)", "금융원가", "InterestExpense"],
    "IS"
  );

  const opCF = findAccount(
    items,
    [
      "영업활동현금흐름",
      "영업활동으로인한현금흐름",
      "NetCashProvidedByUsedInOperatingActivities",
    ],
    "CF"
  );
  const investCF = findAccount(
    items,
    [
      "투자활동현금흐름",
      "투자활동으로인한현금흐름",
      "NetCashProvidedByUsedInInvestingActivities",
    ],
    "CF"
  );
  const financeCF = findAccount(
    items,
    [
      "재무활동현금흐름",
      "재무활동으로인한현금흐름",
      "NetCashProvidedByUsedInFinancingActivities",
    ],
    "CF"
  );

  return {
    revenue: twoYears(revenue),
    net_income: twoYears(netIncome),
    operating_income: twoYears(opIncome),
    interest_expense: twoYears(interest),
    operating_cf: twoYears(opCF),
    investing_cf: twoYears(investCF),
    financing_cf: twoYears(financeCF),
  };
}

// ========== 연차 재무제표 조회 (CFS 우선, 실패 시 OFS) ==========
async function fetchAnnual(corpCode, env) {
  const now = new Date();
  const firstYear = now.getUTCFullYear() - 1;
  const years = [firstYear, firstYear - 1, firstYear - 2];

  for (const year of years) {
    // CFS 시도
    try {
      const data = await dartFetch(
        "fnlttSinglAcntAll",
        {
          corp_code: corpCode,
          bsns_year: year,
          reprt_code: ANNUAL_REPORT,
          fs_div: "CFS",
        },
        env
      );
      if (Array.isArray(data.list) && data.list.length) {
        return { year, items: data.list };
      }
    } catch (_) {
      // CFS 실패 시 OFS 시도
      try {
        const data = await dartFetch(
          "fnlttSinglAcntAll",
          {
            corp_code: corpCode,
            bsns_year: year,
            reprt_code: ANNUAL_REPORT,
            fs_div: "OFS",
          },
          env
        );
        if (Array.isArray(data.list) && data.list.length) {
          return { year, items: data.list };
        }
      } catch (_) {
        // 둘 다 실패하면 다음 연도로
        continue;
      }
    }
  }
  throw new Error("최근 3개년 연결/별도 재무제표를 찾지 못했습니다.");
}

// ========== 최대주주 지분율 조회 ==========
async function fetchLargestShareholder(corpCode, year, env) {
  for (const y of [year, year - 1]) {
    try {
      const data = await dartFetch(
        "hyslrSttus",
        {
          corp_code: corpCode,
          bsns_year: y,
          reprt_code: ANNUAL_REPORT,
        },
        env
      );
      const items = Array.isArray(data.list) ? data.list : [];
      if (!items.length) continue;

      let best = null;
      for (const item of items) {
        const pct = cleanNumber(item.trmend_posesn_stock_qota_rt);
        if (pct !== null && (!best || pct > best.pct)) {
          best = {
            name: item.nm ?? null,
            relation: item.relate ?? null,
            pct,
          };
        }
      }
      return {
        year: y,
        as_of: items[0]?.stlm_dt ?? null,
        pct: best?.pct ?? null,
        holder: best,
      };
    } catch (_) {
      continue;
    }
  }
  return { year: null, as_of: null, pct: null, holder: null };
}

// ========== 판정 로직 ==========
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

  // 프론트엔드가 기대하는 7개 항목 순서
  const results = [
    revenueOk,
    netIncomeOk,
    ocfOk,
    icfOk,
    fcfOk,
    coverageOk,
    ownershipOk,
  ];

  const nonNull = results.filter((v) => v !== null);
  const passed = nonNull.filter((v) => v === true).length;
  const total = nonNull.length;
  const score = total ? `${passed}/${total}` : "N/A";

  return {
    results,
    score,
    passed,
    total,
    revenueGrowth: revenueOk,
    netIncomeOk,
    operatingCFOk: ocfOk,
    investingCFOk: icfOk,
    financingCFOk: fcfOk,
    interestCoverageOk: coverageOk,
    shareholderOk: ownershipOk,
  };
}

function format(v) {
  if (v === null || v === undefined) return "데이터 없음";
  return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

// ========== 단일 종목 분석 ==========
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

// ========== Worker 진입점 ==========
export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DART_API_KEY) {
        return json(
          { ok: false, message: "Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다." },
          500
        );
      }

      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({ ok: true, service: "financial-judge" });
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        const body = await request.json();
        const raw = Array.isArray(body.stock_codes) ? body.stock_codes : [];
        const codes = [...new Set(raw.map(normalizeCode).filter((x) => /^\d{6}$/.test(x)))].slice(
          0,
          10
        );

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

        return json({
          ok: true,
          results,
          analyzed_at: new Date().toISOString(),
        });
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, message: error?.message || String(error) }, 500);
    }
  },
};
