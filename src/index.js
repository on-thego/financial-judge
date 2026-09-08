import { unzipSync, strFromU8 } from "fflate";

const DART_BASE = "https://opendart.fss.or.kr/api";
const ANNUAL_REPORT = "11011";
const CACHE_SECONDS = 21600; // 6시간

const DART_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
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

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "데이터 없음";
  }
  return Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

async function dartFetch(endpoint, params, env) {
  if (!env.DART_API_KEY) {
    throw new Error("Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다.");
  }
  const url = new URL(`${DART_BASE}/${endpoint}.json`);
  const allParams = { ...params, crtfc_key: env.DART_API_KEY };
  Object.entries(allParams).forEach(([key, value]) => url.searchParams.set(key, String(value)));

  const response = await fetch(url.toString(), { headers: DART_FETCH_HEADERS });
  if (!response.ok) throw new Error(`DART HTTP ${response.status}`);

  const data = await response.json();
  if (String(data.status) !== "000") {
    throw new Error(`DART ${data.status}: ${data.message || "API 오류"}`);
  }
  return data;
}

/* =========================================================
   기업코드 — 요청당 1번만 받아오도록 공유 Promise로 사용
   ========================================================= */

async function fetchCorpMap(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://financial-judge.local/_corp_code_map");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${DART_BASE}/corpCode.xml`);
  url.searchParams.set("crtfc_key", env.DART_API_KEY);
  const response = await fetch(url.toString(), { headers: DART_FETCH_HEADERS });
  if (!response.ok) throw new Error(`DART corpCode HTTP ${response.status}`);

  const buf = new Uint8Array(await response.arrayBuffer());
  let files;
  try {
    files = unzipSync(buf);
  } catch (e) {
    throw new Error("DART 기업코드 ZIP 파일을 해제하지 못했습니다.");
  }

  const xmlEntry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith(".xml"));
  if (!xmlEntry) throw new Error("DART 기업코드 XML을 찾지 못했습니다.");

  const xml = strFromU8(xmlEntry[1]);
  const map = {};

  function getTag(block, tag) {
    const start = block.indexOf(`<${tag}>`);
    if (start === -1) return "";
    const end = block.indexOf(`</${tag}>`, start);
    if (end === -1) return "";
    return block.slice(start + tag.length + 2, end).trim();
  }

  let pos = 0;
  while (true) {
    const listStart = xml.indexOf("<list>", pos);
    if (listStart === -1) break;
    const listEnd = xml.indexOf("</list>", listStart);
    if (listEnd === -1) break;
    const block = xml.slice(listStart, listEnd);
    pos = listEnd + 7;

    const stockCode = getTag(block, "stock_code").trim().padStart(6, "0");
    const corpCode = getTag(block, "corp_code").trim().padStart(8, "0");
    const corpName = getTag(block, "corp_name").trim();

    if (/^\d{6}$/.test(stockCode) && stockCode !== "000000" && /^\d{8}$/.test(corpCode) && corpName) {
      map[stockCode] = { corp_code: corpCode, corp_name: corpName };
    }
  }

  const payload = JSON.stringify(map);
  const cacheResponse = new Response(payload, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `max-age=${CACHE_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
  return map;
}

async function resolveStock(stockCode, corpMapPromise) {
  const code = normalizeCode(stockCode);
  const map = await corpMapPromise; // 10개 종목이 같은 Promise를 공유 → 실제 fetch는 요청당 1번
  const company = map[code];
  if (!company) {
    throw new Error(`종목코드 ${code}에 해당하는 기업을 DART에서 찾을 수 없습니다.`);
  }
  return { stock_code: code, corp_code: company.corp_code, corp_name: company.corp_name };
}

/* =========================================================
   계정과목 찾기
   ========================================================= */

function findAccount(items, patterns, sjDiv) {
  const pats = patterns.map(normText);
  const rows = sjDiv ? items.filter((x) => x.sj_div === sjDiv) : items;

  for (const row of rows) {
    const name = normText(row.account_nm);
    if (pats.some((p) => name === p)) return row;
  }
  for (const row of rows) {
    const name = normText(row.account_nm);
    if (pats.some((p) => name.includes(p))) return row;
  }
  return null;
}

function getAmount(row, field) {
  if (!row) return null;
  return cleanNumber(row[field]);
}

async function fetchFinancialStatement(corpCode, year, reportCode, fsDiv, env) {
  return dartFetch("fnlttSinglAcntAll", { corp_code: corpCode, bsns_year: String(year), reprt_code: reportCode, fs_div: fsDiv }, env);
}

/* =========================================================
   최근 3개 결산연도 — 딱 3개 연도만 시도 (더 이상 8년 탐색 안 함)
   ========================================================= */

async function fetchAnnualYears(corpCode, env) {
  const currentYear = new Date().getFullYear();
  const targetYears = [currentYear - 1, currentYear - 2, currentYear - 3];
  const found = [];

  for (const year of targetYears) {
    let data = null;
    let fsDiv = "CFS";

    try {
      data = await fetchFinancialStatement(corpCode, year, ANNUAL_REPORT, "CFS", env);
      if (!data?.list?.length) data = null;
    } catch (e) {
      data = null;
    }

    if (!data) {
      try {
        data = await fetchFinancialStatement(corpCode, year, ANNUAL_REPORT, "OFS", env);
        fsDiv = "OFS";
        if (!data?.list?.length) data = null;
      } catch (e) {
        data = null;
      }
    }

    if (data) {
      found.push({ year, items: data.list, fs_div: fsDiv });
    }
    // 못 찾은 연도는 건너뛰고 계속 진행 — 8년까지 뒤로 확장하지 않음
  }

  if (found.length === 0) {
    throw new Error("최근 3개 회계연도 재무제표를 찾을 수 없습니다.");
  }

  return found;
}

function extractAnnualFinancials(items) {
  const revenue = findAccount(items, ["매출액", "수익(매출액)", "영업수익"], "IS");
  const netIncome = findAccount(items, ["당기순이익", "당기순이익(손실)", "당기순손익"], "IS");
  const operatingCF = findAccount(items, ["영업활동으로인한현금흐름", "영업활동현금흐름"], "CF");
  const investingCF = findAccount(items, ["투자활동으로인한현금흐름", "투자활동현금흐름"], "CF");
  const financingCF = findAccount(items, ["재무활동으로인한현금흐름", "재무활동현금흐름"], "CF");
  const interestExpense = findAccount(items, ["이자비용"], "IS");
  const operatingIncome = findAccount(items, ["영업이익", "영업이익(손실)"], "IS");

  const current = (row) => getAmount(row, "thstrm_amount");
  const previous = (row) => getAmount(row, "frmtrm_amount");

  const revenueValue = current(revenue);
  const netIncomeValue = current(netIncome);
  const operatingCFValue = current(operatingCF);
  const investingCFValue = current(investingCF);
  const financingCFValue = current(financingCF);
  const interestValue = current(interestExpense);
  const operatingIncomeValue = current(operatingIncome);

  let interestCoverage = null;
  if (operatingIncomeValue !== null && interestValue !== null && interestValue !== 0) {
    interestCoverage = operatingIncomeValue / Math.abs(interestValue);
  }

  return {
    revenue: revenueValue,
    previous_revenue: previous(revenue),
    net_income: netIncomeValue,
    previous_net_income: previous(netIncome),
    operating_cf: operatingCFValue,
    investing_cf: investingCFValue,
    financing_cf: financingCFValue,
    operating_income: operatingIncomeValue,
    interest_expense: interestValue,
    interest_coverage: interestCoverage,
  };
}

/* =========================================================
   최근 분기 — 올해만 시도, 없으면 작년 1번만 더 (2년 초과 탐색 안 함)
   ========================================================= */

const QUARTER_REPORTS = [
  { code: "11014", quarter: 3, name: "3분기" },
  { code: "11012", quarter: 2, name: "2분기" },
  { code: "11013", quarter: 1, name: "1분기" },
];

async function tryQuarterData(corpCode, year, reportCode, env) {
  try {
    const data = await fetchFinancialStatement(corpCode, year, reportCode, "CFS", env);
    if (data?.list?.length) return { year, report_code: reportCode, items: data.list, fs_div: "CFS" };
  } catch (e) {}

  try {
    const data = await fetchFinancialStatement(corpCode, year, reportCode, "OFS", env);
    if (data?.list?.length) return { year, report_code: reportCode, items: data.list, fs_div: "OFS" };
  } catch (e) {}

  return null;
}

async function fetchQuarterReport(corpCode, env) {
  const currentYear = new Date().getFullYear();

  // 올해 → 안 되면 작년, 딱 2년까지만 (기존 3년 루프에서 축소)
  for (const year of [currentYear, currentYear - 1]) {
    for (const report of QUARTER_REPORTS) {
      const current = await tryQuarterData(corpCode, year, report.code, env);
      if (!current) continue;

      const previous = await tryQuarterData(corpCode, year - 1, report.code, env);

      return { current, previous, quarter: report.quarter, quarter_name: report.name };
    }
  }

  return null;
}

function getStatementValue(items, patterns, sjDiv) {
  const row = findAccount(items, patterns, sjDiv);
  if (!row) return null;
  return { current: cleanNumber(row.thstrm_amount), previous: cleanNumber(row.frmtrm_amount) };
}

function extractQuarterCumulative(report) {
  if (!report) return null;
  const items = report.items;

  const revenue = getStatementValue(items, ["매출액", "수익(매출액)", "영업수익"], "IS");
  const netIncome = getStatementValue(items, ["당기순이익", "당기순이익(손실)", "당기순손익"], "IS");
  const operatingIncome = getStatementValue(items, ["영업이익", "영업이익(손실)"], "IS");
  const interestExpense = getStatementValue(items, ["이자비용"], "IS");

  return {
    revenue: revenue?.current ?? null,
    net_income: netIncome?.current ?? null,
    operating_income: operatingIncome?.current ?? null,
    interest_expense: interestExpense?.current ?? null,
  };
}

function subtractValues(current, previous) {
  if (current === null || current === undefined) return null;
  if (previous === null || previous === undefined) return null;
  return current - previous;
}

function calculateInterestCoverage(operatingIncome, interestExpense) {
  if (operatingIncome === null || interestExpense === null || interestExpense === 0) return null;
  return operatingIncome / Math.abs(interestExpense);
}

async function buildQuarterData(corpCode, year, quarter, report, env) {
  const cumulative = extractQuarterCumulative(report);
  if (!cumulative) return null;

  if (quarter === 1) {
    return {
      year, quarter,
      revenue: cumulative.revenue,
      net_income: cumulative.net_income,
      operating_income: cumulative.operating_income,
      interest_expense: cumulative.interest_expense,
      interest_coverage: calculateInterestCoverage(cumulative.operating_income, cumulative.interest_expense),
    };
  }

  if (quarter === 2) {
    const q1 = await tryQuarterData(corpCode, year, "11013", env);
    const q1Values = extractQuarterCumulative(q1);
    if (!q1Values) {
      return { year, quarter, revenue: null, net_income: null, operating_income: null, interest_expense: null, interest_coverage: null };
    }
    const revenue = subtractValues(cumulative.revenue, q1Values.revenue);
    const netIncome = subtractValues(cumulative.net_income, q1Values.net_income);
    const operatingIncome = subtractValues(cumulative.operating_income, q1Values.operating_income);
    const interestExpense = subtractValues(cumulative.interest_expense, q1Values.interest_expense);
    return { year, quarter, revenue, net_income: netIncome, operating_income: operatingIncome, interest_expense: interestExpense, interest_coverage: calculateInterestCoverage(operatingIncome, interestExpense) };
  }

  if (quarter === 3) {
    const h1 = await tryQuarterData(corpCode, year, "11012", env);
    const h1Values = extractQuarterCumulative(h1);
    if (!h1Values) {
      return { year, quarter, revenue: null, net_income: null, operating_income: null, interest_expense: null, interest_coverage: null };
    }
    const revenue = subtractValues(cumulative.revenue, h1Values.revenue);
    const netIncome = subtractValues(cumulative.net_income, h1Values.net_income);
    const operatingIncome = subtractValues(cumulative.operating_income, h1Values.operating_income);
    const interestExpense = subtractValues(cumulative.interest_expense, h1Values.interest_expense);
    return { year, quarter, revenue, net_income: netIncome, operating_income: operatingIncome, interest_expense: interestExpense, interest_coverage: calculateInterestCoverage(operatingIncome, interestExpense) };
  }

  return null;
}

async function fetchLatestQuarter(corpCode, env) {
  const found = await fetchQuarterReport(corpCode, env);
  if (!found) return null;

  const current = await buildQuarterData(corpCode, found.current.year, found.quarter, found.current, env);
  let previous = null;
  if (found.previous) {
    previous = await buildQuarterData(corpCode, found.previous.year, found.quarter, found.previous, env);
  }

  return { current, previous, year: found.current.year, quarter: found.quarter, quarter_name: found.quarter_name };
}

async function fetchLargestShareholder(corpCode, year, env) {
  try {
    const data = await dartFetch("hyslrSttus", { corp_code: corpCode, bsns_year: String(year), reprt_code: ANNUAL_REPORT }, env);
    const list = data?.list || [];
    let best = null;
    for (const row of list) {
      const ratio = cleanNumber(row.trmend_posesn_stock_qota_rt);
      if (ratio === null) continue;
      if (!best || ratio > best.ratio) {
        best = { name: row.nm || row.stockhold_qota_rt_nm || "-", ratio, year };
      }
    }
    return best;
  } catch (e) {
    return null;
  }
}

/* =========================================================
   판정 (기존과 동일)
   ========================================================= */

function judge(annuals, latestQuarter, shareholder) {
  const results = [];
  function addResult(key, label, value, status, rule) {
    results.push({ key, label, value, status, rule });
  }

  const annualRevenue = annuals.slice().sort((a, b) => a.year - b.year);
  let annualRevenueIncreasing = null;
  if (annualRevenue.length === 3 && annualRevenue.every((x) => x.financials.revenue !== null)) {
    annualRevenueIncreasing =
      annualRevenue[0].financials.revenue < annualRevenue[1].financials.revenue &&
      annualRevenue[1].financials.revenue < annualRevenue[2].financials.revenue;
  }

  let quarterRevenueIncreasing = null;
  if (latestQuarter?.current && latestQuarter?.previous && latestQuarter.current.revenue !== null && latestQuarter.previous.revenue !== null) {
    quarterRevenueIncreasing = latestQuarter.current.revenue > latestQuarter.previous.revenue;
  }

  let revenueOk = null;
  if (annualRevenueIncreasing !== null && quarterRevenueIncreasing !== null) {
    revenueOk = annualRevenueIncreasing && quarterRevenueIncreasing;
  }

  let revenueValue = "데이터 없음";
  if (annualRevenueIncreasing !== null) {
    const trend = annualRevenue.map((x) => `${x.year} ${formatNumber(x.financials.revenue)}`).join(" → ");
    revenueValue = `${trend} / 최근분기 전년동기 ${quarterRevenueIncreasing ? "증가" : "감소"}`;
  }

  addResult("revenue_growth", "매출액 증가", revenueValue, revenueOk === true ? "양호" : revenueOk === false ? "불량" : "데이터 없음", "최근 3개 결산연도 매출액이 연속 증가하고 최근분기 매출액이 전년동기 대비 증가");

  const profitPeriods = [];
  for (const annual of annuals) {
    profitPeriods.push({ type: "annual", year: annual.year, quarter: null, value: annual.financials.net_income });
  }
  if (latestQuarter?.current) {
    profitPeriods.push({ type: "quarter", year: latestQuarter.year, quarter: latestQuarter.quarter, value: latestQuarter.current.net_income });
  }

  let netIncomeOk = null;
  const allProfitData = profitPeriods.every((x) => x.value !== null);
  if (allProfitData) {
    let consecutiveLoss = 0;
    let hasConsecutiveLoss = false;
    for (const p of profitPeriods) {
      if (p.value < 0) {
        consecutiveLoss++;
        if (consecutiveLoss >= 2) hasConsecutiveLoss = true;
      } else {
        consecutiveLoss = 0;
      }
    }
    netIncomeOk = !hasConsecutiveLoss;
  }

  let netIncomeValue = "데이터 없음";
  if (allProfitData) {
    netIncomeValue = profitPeriods.map((p) => (p.type === "annual" ? `${p.year}년 ${formatNumber(p.value)}` : `${p.year} Q${p.quarter} ${formatNumber(p.value)}`)).join(" / ");
  }

  addResult("net_income", "당기순이익 연속 적자", netIncomeValue, netIncomeOk === true ? "양호" : netIncomeOk === false ? "불량" : "데이터 없음", "최근 3개 결산연도와 최근분기에서 연속적인 적자가 없어야 함");

  const latestAnnual = annuals[0];

  let operatingCFOk = null;
  if (latestAnnual?.financials.operating_cf !== null) operatingCFOk = latestAnnual.financials.operating_cf > 0;
  addResult("operating_cf", "영업활동 현금흐름", latestAnnual?.financials.operating_cf !== null ? formatNumber(latestAnnual.financials.operating_cf) : "데이터 없음", operatingCFOk === true ? "양호" : operatingCFOk === false ? "불량" : "데이터 없음", "최근 결산 영업활동 현금흐름 > 0");

  let investingCFOk = null;
  if (latestAnnual?.financials.investing_cf !== null) investingCFOk = latestAnnual.financials.investing_cf < 0;
  addResult("investing_cf", "투자활동 현금흐름", latestAnnual?.financials.investing_cf !== null ? formatNumber(latestAnnual.financials.investing_cf) : "데이터 없음", investingCFOk === true ? "양호" : investingCFOk === false ? "불량" : "데이터 없음", "최근 결산 투자활동 현금흐름 < 0");

  let financingCFOk = null;
  if (latestAnnual?.financials.financing_cf !== null) financingCFOk = latestAnnual.financials.financing_cf < 0;
  addResult("financing_cf", "재무활동 현금흐름", latestAnnual?.financials.financing_cf !== null ? formatNumber(latestAnnual.financials.financing_cf) : "데이터 없음", financingCFOk === true ? "양호" : financingCFOk === false ? "불량" : "데이터 없음", "최근 결산 재무활동 현금흐름 < 0");

  const coveragePeriods = [];
  for (const annual of annuals) {
    coveragePeriods.push({ label: `${annual.year}년`, value: annual.financials.interest_coverage });
  }
  if (latestQuarter?.current) {
    coveragePeriods.push({ label: `${latestQuarter.year} Q${latestQuarter.quarter}`, value: latestQuarter.current.interest_coverage });
  }

  const allCoverageData = coveragePeriods.length === 4 && coveragePeriods.every((x) => x.value !== null && Number.isFinite(Number(x.value)));
  let interestCoverageOk = null;
  if (allCoverageData) interestCoverageOk = coveragePeriods.every((x) => Number(x.value) >= 1.0);

  let interestCoverageValue = "데이터 없음";
  if (coveragePeriods.some((x) => x.value !== null)) {
    interestCoverageValue = coveragePeriods.map((x) => (x.value === null ? `${x.label} 데이터 없음` : `${x.label} ${formatNumber(x.value)}배`)).join(" / ");
  }

  addResult("interest_coverage", "이자보상배율", interestCoverageValue, interestCoverageOk === true ? "양호" : interestCoverageOk === false ? "불량" : "데이터 없음", "최근 3개 결산연도와 최근분기의 이자보상배율이 모두 1.0배 이상");

  let shareholderOk = null;
  if (shareholder && shareholder.ratio !== null) shareholderOk = shareholder.ratio >= 20.0;
  addResult("largest_shareholder", "대주주 지분율", shareholder ? `${formatNumber(shareholder.ratio)}%` : "데이터 없음", shareholderOk === true ? "양호" : shareholderOk === false ? "불량" : "데이터 없음", "대주주 지분율 ≥ 20.0%");

  const values = [revenueOk, netIncomeOk, operatingCFOk, investingCFOk, financingCFOk, interestCoverageOk, shareholderOk];
  const passed = values.filter((v) => v === true).length;
  const evaluated = values.filter((v) => v !== null).length; // 데이터가 있어서 실제 판정한 항목 수
  const missing = values.length - evaluated;                  // 데이터 없어서 제외된 항목 수

  return {
    results,
    derived: {
      interest_coverage: latestQuarter?.current?.interest_coverage ?? latestAnnual?.financials?.interest_coverage ?? null,
      largest_shareholder_pct: shareholder ? shareholder.ratio : null,
    },
    passed,          // 충족(양호) 개수
    evaluated,        // 데이터가 있어 실제로 평가된 항목 수
    total_criteria: 7, // 전체 판정 항목 수 (고정)
    missing,          // 데이터 없어 제외된 항목 수
  };
}


/* =========================================================
   개별 기업 분석
   ========================================================= */

async function analyzeOne(stockCode, env, ctx, corpMapPromise) {
  const company = await resolveStock(stockCode, corpMapPromise);

  const annualReports = await fetchAnnualYears(company.corp_code, env);
  const annuals = annualReports.map((report) => ({
    year: report.year,
    fs_div: report.fs_div,
    financials: extractAnnualFinancials(report.items),
  }));

  const latestQuarter = await fetchLatestQuarter(company.corp_code, env);
  const shareholder = await fetchLargestShareholder(company.corp_code, annuals[0].year, env);
  const judgement = judge(annuals, latestQuarter, shareholder);

  return {
    ok: true,
    stock_code: company.stock_code,
    corp_name: company.corp_name,
    corp_code: company.corp_code,
    report_year: annuals[0].year,
    annuals,
    latest_quarter: latestQuarter,
    largest_shareholder: shareholder || { name: "-", ratio: null, year: null },
    judgement,
  };
}

/* =========================================================
   Worker
   ========================================================= */

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DART_API_KEY) {
        return json({ ok: false, message: "Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다." }, 500);
      }

      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({ ok: true, service: "financial-judge", dart_key: "configured" });
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return json({ ok: false, message: "JSON 요청을 읽을 수 없습니다." }, 400);
        }

        const raw = Array.isArray(body.stock_codes) ? body.stock_codes : [];
        const codes = [...new Set(raw.map(normalizeCode).filter((x) => /^\d{6}$/.test(x)))].slice(0, 10);

        if (!codes.length) {
          return json({ ok: false, message: "분석할 6자리 종목코드를 입력하세요." }, 400);
        }

        // 기업코드 조회는 요청당 딱 1번만 시작 — 모든 종목이 같은 Promise를 공유
        const corpMapPromise = fetchCorpMap(env, ctx);

        const results = await Promise.all(
          codes.map(async (code) => {
            try {
              return await analyzeOne(code, env, ctx, corpMapPromise);
            } catch (e) {
              return { ok: false, stock_code: code, corp_name: null, error: e.message || String(e) };
            }
          })
        );

        return json({
          ok: true,
          count: results.length,
          success: results.filter((x) => x.ok).length,
          failed: results.filter((x) => !x.ok).length,
          results,
        });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ ok: false, message: e.message || String(e) }, 500);
    }
  },
};
