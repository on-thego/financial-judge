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
  return String(value ?? "")
    .replace(/\D/g, "")
    .padStart(6, "0");
}

function cleanNumber(value) {
  if (value === null || value === undefined) return null;

  let s = String(value).trim().replaceAll(",", "");

  if (!s || ["-", "–", "—", "N/A", "nan"].includes(s)) {
    return null;
  }

  if (/^\(.*\)$/.test(s)) {
    s = "-" + s.slice(1, -1);
  }

  s = s.replace(/[^\d.-]/g, "");

  const n = Number(s);

  return Number.isFinite(n) ? n : null;
}

function normText(value) {
  return String(value ?? "")
    .replace(/[\s\u00a0]/g, "")
    .toLowerCase();
}

async function dartFetch(endpoint, params, env) {
  if (!env.DART_API_KEY) {
    throw new Error(
      "Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다."
    );
  }

  const url = new URL(`${DART_BASE}/${endpoint}.json`);

  const allParams = {
    ...params,
    crtfc_key: env.DART_API_KEY,
  };

  Object.entries(allParams).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  const response = await fetch(url.toString(), {
    headers: DART_FETCH_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`DART HTTP ${response.status}`);
  }

  const data = await response.json();

  if (String(data.status) !== "000") {
    throw new Error(
      `DART ${data.status}: ${data.message || "API 오류"}`
    );
  }

  return data;
}

/**
 * DART corpCode.xml
 *
 * 종목코드 -> {
 *   corp_code,
 *   corp_name
 * }
 *
 * 구조로 변환한다.
 */
async function fetchCorpMap(env, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(
    "https://financial-judge.local/_corp_code_map"
  );

  // 캐시 확인
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached.json();
  }

  const url = new URL(`${DART_BASE}/corpCode.xml`);

  url.searchParams.set(
    "crtfc_key",
    env.DART_API_KEY
  );

  const response = await fetch(url.toString(), {
    headers: DART_FETCH_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `DART corpCode HTTP ${response.status}`
    );
  }

  const buf = new Uint8Array(
    await response.arrayBuffer()
  );

  let files;

  try {
    files = unzipSync(buf);
  } catch (e) {
    throw new Error(
      "DART 기업코드 ZIP 파일을 해제하지 못했습니다."
    );
  }

  const xmlEntry = Object.entries(files).find(
    ([name]) =>
      name.toLowerCase().endsWith(".xml")
  );

  if (!xmlEntry) {
    throw new Error(
      "DART 기업코드 XML을 찾지 못했습니다."
    );
  }

  const xml = strFromU8(xmlEntry[1]);

  const map = {};

  function getTag(block, tag) {
    const start = block.indexOf(
      `<${tag}>`
    );

    if (start === -1) {
      return "";
    }

    const end = block.indexOf(
      `</${tag}>`,
      start
    );

    if (end === -1) {
      return "";
    }

    return block
      .slice(
        start + tag.length + 2,
        end
      )
      .trim();
  }

  let pos = 0;

  while (true) {
    const listStart = xml.indexOf(
      "<list>",
      pos
    );

    if (listStart === -1) {
      break;
    }

    const listEnd = xml.indexOf(
      "</list>",
      listStart
    );

    if (listEnd === -1) {
      break;
    }

    const block = xml.slice(
      listStart,
      listEnd
    );

    pos = listEnd + 7;

    const stockCode = getTag(
      block,
      "stock_code"
    )
      .trim()
      .padStart(6, "0");

    const corpCode = getTag(
      block,
      "corp_code"
    )
      .trim()
      .padStart(8, "0");

    const corpName = getTag(
      block,
      "corp_name"
    ).trim();

    if (
      /^\d{6}$/.test(stockCode) &&
      stockCode !== "000000" &&
      /^\d{8}$/.test(corpCode) &&
      corpName
    ) {
      map[stockCode] = {
        corp_code: corpCode,
        corp_name: corpName,
      };
    }
  }

  const payload = JSON.stringify(map);

  const cacheResponse = new Response(
    payload,
    {
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control":
          `max-age=${CACHE_SECONDS}`,
      },
    }
  );

  ctx.waitUntil(
    cache.put(
      cacheKey,
      cacheResponse.clone()
    )
  );

  return map;
}

async function resolveStock(
  stockCode,
  env,
  ctx
) {
  const code = normalizeCode(stockCode);

  const map = await fetchCorpMap(
    env,
    ctx
  );

  const company = map[code];

  if (!company) {
    throw new Error(
      `종목코드 ${code}에 해당하는 기업을 DART에서 찾을 수 없습니다.`
    );
  }

  return {
    stock_code: code,
    corp_code: company.corp_code,
    corp_name: company.corp_name,
  };
}

/**
 * 계정과목 찾기
 */
function findAccount(
  items,
  patterns,
  sjDiv
) {
  const pats = patterns.map(normText);

  const rows = sjDiv
    ? items.filter(
        (x) => x.sj_div === sjDiv
      )
    : items;

  for (const row of rows) {
    const name = normText(
      row.account_nm
    );

    if (
      pats.some(
        (p) =>
          name === p ||
          name.includes(p)
      )
    ) {
      return row;
    }
  }

  return null;
}

/**
 * 최근 사업보고서 조회
 *
 * 현재 연도 → 전년도 → 전전년도 순으로 검색
 */
async function fetchAnnual(
  corpCode,
  env
) {
  const now = new Date();

  const thisYear =
    now.getFullYear();

  const years = [
    thisYear,
    thisYear - 1,
    thisYear - 2,
  ];

  const errors = [];

  for (const year of years) {
    // 연결재무제표
    try {
      const data =
        await dartFetch(
          "fnlttSinglAcntAll",
          {
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code:
              ANNUAL_REPORT,
            fs_div: "CFS",
          },
          env
        );

      if (
        Array.isArray(data.list) &&
        data.list.length > 0
      ) {
        return {
          year,
          items: data.list,
          fs_div: "CFS",
        };
      }
    } catch (e) {
      errors.push(
        `CFS ${year}: ${e.message}`
      );
    }

    // 별도재무제표
    try {
      const data =
        await dartFetch(
          "fnlttSinglAcntAll",
          {
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code:
              ANNUAL_REPORT,
            fs_div: "OFS",
          },
          env
        );

      if (
        Array.isArray(data.list) &&
        data.list.length > 0
      ) {
        return {
          year,
          items: data.list,
          fs_div: "OFS",
        };
      }
    } catch (e) {
      errors.push(
        `OFS ${year}: ${e.message}`
      );
    }
  }

  throw new Error(
    "최근 3개년 사업보고서 재무제표를 찾을 수 없습니다."
  );
}

/**
 * 최대주주 조회
 */
async function fetchLargestShareholder(
  corpCode,
  year,
  env
) {
  try {
    const data =
      await dartFetch(
        "hyslrSttus",
        {
          corp_code: corpCode,
          bsns_year: String(year),
          reprt_code:
            ANNUAL_REPORT,
        },
        env
      );

    const list =
      data?.list || [];

    let best = null;

    for (const row of list) {
      const ratio =
        cleanNumber(
          row.trmend_posesn_stock_qota_rt
        );

      if (ratio === null) {
        continue;
      }

      if (
        !best ||
        ratio > best.ratio
      ) {
        best = {
          name:
            row.nm ||
            row.stockhold_qota_rt_nm ||
            "-",

          ratio,

          year,
        };
      }
    }

    return best;
  } catch (e) {
    return null;
  }
}

/**
 * 재무 데이터 추출
 */
function extractFinancials(
  items
) {
  const revenue =
    findAccount(
      items,
      [
        "매출액",
        "수익(매출액)",
        "영업수익",
      ],
      "IS"
    );

  const netIncome =
    findAccount(
      items,
      [
        "당기순이익",
        "당기순이익(손실)",
      ],
      "IS"
    );

  const operatingCF =
    findAccount(
      items,
      [
        "영업활동으로인한현금흐름",
        "영업활동현금흐름",
      ],
      "CF"
    );

  const investingCF =
    findAccount(
      items,
      [
        "투자활동으로인한현금흐름",
        "투자활동현금흐름",
      ],
      "CF"
    );

  const financingCF =
    findAccount(
      items,
      [
        "재무활동으로인한현금흐름",
        "재무활동현금흐름",
      ],
      "CF"
    );

  const interestExpense =
    findAccount(
      items,
      ["이자비용"],
      "IS"
    );

  const operatingIncome =
    findAccount(
      items,
      [
        "영업이익",
        "영업이익(손실)",
      ],
      "IS"
    );

  function pair(row) {
    return {
      curr:
        row
          ? cleanNumber(
              row.thstrm_amount
            )
          : null,

      prev:
        row
          ? cleanNumber(
              row.frmtrm_amount
            )
          : null,
    };
  }

  const revenueData =
    pair(revenue);

  const netIncomeData =
    pair(netIncome);

  const operatingCFData =
    pair(operatingCF);

  const investingCFData =
    pair(investingCF);

  const financingCFData =
    pair(financingCF);

  const interestExpenseData =
    pair(interestExpense);

  const operatingIncomeData =
    pair(operatingIncome);

  let interestCoverage =
    null;

  if (
    operatingIncomeData.curr !==
      null &&
    interestExpenseData.curr !==
      null &&
    interestExpenseData.curr !== 0
  ) {
    interestCoverage =
      operatingIncomeData.curr /
      Math.abs(
        interestExpenseData.curr
      );
  }

  return {
    revenue: revenueData,

    netIncome: netIncomeData,

    operatingCF:
      operatingCFData,

    investingCF:
      investingCFData,

    financingCF:
      financingCFData,

    interestExpense:
      interestExpenseData,

    operatingIncome:
      operatingIncomeData,

    interestCoverage,
  };
}

/**
 * 판정 결과 생성
 *
 * index.html에서 사용하는 구조:
 *
 * judgement.results
 * judgement.derived
 * judgement.score
 * judgement.total
 */
function judge(
  financials,
  shareholder
) {
  const results = [];

  function addResult(
    key,
    label,
    value,
    status,
    rule
  ) {
    results.push({
      key,
      label,
      value,
      status,
      rule,
    });
  }

  // 1. 매출액 증가
  let revenueGrowth = null;

  if (
    financials.revenue.curr !==
      null &&
    financials.revenue.prev !==
      null
  ) {
    revenueGrowth =
      financials.revenue.curr >
      financials.revenue.prev;
  }

  addResult(
    "revenue_growth",
    "매출액 증가",
    financials.revenue.curr !==
      null
      ? financials.revenue.curr
      : "데이터 없음",
    revenueGrowth === true
      ? "양호"
      : revenueGrowth === false
        ? "불량"
        : "데이터 없음",
    "최근년도 > 전년도"
  );

  // 2. 순이익
  let netIncomeOk = null;

  if (
    financials.netIncome.curr !==
    null
  ) {
    netIncomeOk =
      financials.netIncome.curr >=
      0;
  }

  addResult(
    "net_income",
    "당기순이익",
    financials.netIncome.curr !==
      null
      ? financials.netIncome.curr
      : "데이터 없음",
    netIncomeOk === true
      ? "양호"
      : netIncomeOk === false
        ? "불량"
        : "데이터 없음",
    "최근년도 순이익 ≥ 0"
  );

  // 3. 영업활동 CF
  let operatingCFOk = null;

  if (
    financials.operatingCF.curr !==
    null
  ) {
    operatingCFOk =
      financials.operatingCF.curr >
      0;
  }

  addResult(
    "operating_cf",
    "영업활동 현금흐름",
    financials.operatingCF.curr !==
      null
      ? financials.operatingCF.curr
      : "데이터 없음",
    operatingCFOk === true
      ? "양호"
      : operatingCFOk === false
        ? "불량"
        : "데이터 없음",
    "0 초과"
  );

  // 4. 투자활동 CF
  let investingCFOk = null;

  if (
    financials.investingCF.curr !==
    null
  ) {
    investingCFOk =
      financials.investingCF.curr <
      0;
  }

  addResult(
    "investing_cf",
    "투자활동 현금흐름",
    financials.investingCF.curr !==
      null
      ? financials.investingCF.curr
      : "데이터 없음",
    investingCFOk === true
      ? "양호"
      : investingCFOk === false
        ? "불량"
        : "데이터 없음",
    "0 미만"
  );

  // 5. 재무활동 CF
  let financingCFOk = null;

  if (
    financials.financingCF.curr !==
    null
  ) {
    financingCFOk =
      financials.financingCF.curr <
      0;
  }

  addResult(
    "financing_cf",
    "재무활동 현금흐름",
    financials.financingCF.curr !==
      null
      ? financials.financingCF.curr
      : "데이터 없음",
    financingCFOk === true
      ? "양호"
      : financingCFOk === false
        ? "불량"
        : "데이터 없음",
    "0 미만"
  );

  // 6. 이자보상배율
  let interestCoverageOk = null;

  if (
    financials.interestCoverage !==
    null
  ) {
    interestCoverageOk =
      financials.interestCoverage >=
      1.0;
  }

  addResult(
    "interest_coverage",
    "이자보상배율",
    financials.interestCoverage !==
      null
      ? `${financials.interestCoverage.toLocaleString(
          "ko-KR",
          {
            maximumFractionDigits: 2,
          }
        )}배`
      : "데이터 없음",
    interestCoverageOk === true
      ? "양호"
      : interestCoverageOk === false
        ? "불량"
        : "데이터 없음",
    "1.0배 이상"
  );

  // 7. 최대주주 지분율
  let shareholderOk = null;

  if (
    shareholder &&
    shareholder.ratio !== null
  ) {
    shareholderOk =
      shareholder.ratio >= 20.0;
  }

  addResult(
    "largest_shareholder",
    "대주주 지분율",
    shareholder &&
    shareholder.ratio !== null
      ? `${shareholder.ratio.toLocaleString(
          "ko-KR",
          {
            maximumFractionDigits: 2,
          }
        )}%`
      : "데이터 없음",
    shareholderOk === true
      ? "양호"
      : shareholderOk === false
        ? "불량"
        : "데이터 없음",
    "20.0% 이상"
  );

  const boolValues = [
    revenueGrowth,
    netIncomeOk,
    operatingCFOk,
    investingCFOk,
    financingCFOk,
    interestCoverageOk,
    shareholderOk,
  ];

  const passed =
    boolValues.filter(
      (v) => v === true
    ).length;

  const total =
    boolValues.filter(
      (v) => v !== null
    ).length;

  return {
    results,

    derived: {
      interest_coverage:
        financials.interestCoverage,

      largest_shareholder_pct:
        shareholder
          ? shareholder.ratio
          : null,
    },

    score:
      total > 0
        ? `${passed}/${total}`
        : "N/A",

    total: 7,

    passed,
  };
}

/**
 * 개별 종목 분석
 */
async function analyzeOne(
  stockCode,
  env,
  ctx
) {
  const company =
    await resolveStock(
      stockCode,
      env,
      ctx
    );

  const annual =
    await fetchAnnual(
      company.corp_code,
      env
    );

  const financials =
    extractFinancials(
      annual.items
    );

  const shareholder =
    await fetchLargestShareholder(
      company.corp_code,
      annual.year,
      env
    );

  const judgement =
    judge(
      financials,
      shareholder
    );

  return {
    ok: true,

    stock_code:
      company.stock_code,

    // ★ 종목명
    corp_name:
      company.corp_name,

    // DART 기업코드
    corp_code:
      company.corp_code,

    // 사업보고서 연도
    report_year:
      annual.year,

    // CFS / OFS
    fs_div:
      annual.fs_div,

    financials,

    largest_shareholder:
      shareholder,

    judgement,
  };
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      // --------------------------------------------------
      // DART API KEY 확인
      // --------------------------------------------------

      if (!env.DART_API_KEY) {
        return json(
          {
            ok: false,
            message:
              "Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다.",
          },
          500
        );
      }

      const url =
        new URL(
          request.url
        );

      // --------------------------------------------------
      // Health check
      // --------------------------------------------------

      if (
        url.pathname ===
        "/health"
      ) {
        return json({
          ok: true,
          service:
            "financial-judge",
          dart_key:
            "configured",
        });
      }

      // --------------------------------------------------
      // 분석 API
      // --------------------------------------------------

      if (
        url.pathname ===
          "/api/analyze" &&
        request.method ===
          "POST"
      ) {
        let body;

        try {
          body =
            await request.json();
        } catch (e) {
          return json(
            {
              ok: false,
              message:
                "JSON 요청을 읽을 수 없습니다.",
            },
            400
          );
        }

        const raw =
          Array.isArray(
            body.stock_codes
          )
            ? body.stock_codes
            : [];

        const codes = [
          ...new Set(
            raw
              .map(
                normalizeCode
              )
              .filter(
                (x) =>
                  /^\d{6}$/.test(
                    x
                  )
              )
          ),
        ].slice(0, 10);

        if (
          !codes.length
        ) {
          return json(
            {
              ok: false,
              message:
                "분석할 6자리 종목코드를 입력하세요.",
            },
            400
          );
        }

        // 각 종목을 독립적으로 분석
        const results =
          await Promise.all(
            codes.map(
              async (code) => {
                try {
                  return await analyzeOne(
                    code,
                    env,
                    ctx
                  );
                } catch (e) {
                  return {
                    ok: false,

                    stock_code:
                      code,

                    corp_name:
                      null,

                    error:
                      e.message ||
                      String(e),
                  };
                }
              }
            )
          );

        return json({
          ok: true,

          count:
            results.length,

          success:
            results.filter(
              (x) => x.ok
            ).length,

          failed:
            results.filter(
              (x) => !x.ok
            ).length,

          results,
        });
      }

      // --------------------------------------------------
      // 그 외 요청은 정적 파일로 전달
      // --------------------------------------------------

      return env.ASSETS.fetch(
        request
      );
    } catch (e) {
      return json(
        {
          ok: false,
          message:
            e.message ||
            String(e),
        },
        500
      );
    }
  },
};
