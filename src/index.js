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

/* =========================================================
   기본 유틸
   ========================================================= */

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
  if (value === null || value === undefined) {
    return null;
  }

  let s = String(value)
    .trim()
    .replaceAll(",", "");

  if (
    !s ||
    ["-", "–", "—", "N/A", "nan"].includes(s)
  ) {
    return null;
  }

  // (1,234) 형태를 -1234로 변환
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

function formatNumber(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "자료없음";
  }

  return Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits: 2,
  });
}

function formatPercent(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "자료없음";
  }

  const n = Number(value);

  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/* =========================================================
   DART API
   ========================================================= */

async function dartFetch(endpoint, params, env) {
  if (!env.DART_API_KEY) {
    throw new Error(
      "Cloudflare Worker에 DART_API_KEY Secret이 설정되지 않았습니다."
    );
  }

  const url = new URL(
    `${DART_BASE}/${endpoint}.json`
  );

  const allParams = {
    ...params,
    crtfc_key: env.DART_API_KEY,
  };

  Object.entries(allParams).forEach(
    ([key, value]) => {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  );

  const response = await fetch(
    url.toString(),
    {
      headers: DART_FETCH_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(
      `DART HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (String(data.status) !== "000") {
    throw new Error(
      `DART ${data.status}: ${
        data.message || "API 오류"
      }`
    );
  }

  return data;
}

/* =========================================================
   종목코드 → DART 기업정보
   ========================================================= */

async function fetchCorpMap(env, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(
    "https://financial-judge.local/_corp_code_map"
  );

  const cached =
    await cache.match(cacheKey);

  if (cached) {
    return cached.json();
  }

  const url = new URL(
    `${DART_BASE}/corpCode.xml`
  );

  url.searchParams.set(
    "crtfc_key",
    env.DART_API_KEY
  );

  const response = await fetch(
    url.toString(),
    {
      headers: DART_FETCH_HEADERS,
    }
  );

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

  const xmlEntry =
    Object.entries(files).find(
      ([name]) =>
        name
          .toLowerCase()
          .endsWith(".xml")
    );

  if (!xmlEntry) {
    throw new Error(
      "DART 기업코드 XML을 찾지 못했습니다."
    );
  }

  const xml =
    strFromU8(xmlEntry[1]);

  const map = {};

  function getTag(
    block,
    tag
  ) {
    const start =
      block.indexOf(
        `<${tag}>`
      );

    if (start === -1) {
      return "";
    }

    const end =
      block.indexOf(
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
    const listStart =
      xml.indexOf(
        "<list>",
        pos
      );

    if (listStart === -1) {
      break;
    }

    const listEnd =
      xml.indexOf(
        "</list>",
        listStart
      );

    if (listEnd === -1) {
      break;
    }

    const block =
      xml.slice(
        listStart,
        listEnd
      );

    pos =
      listEnd + 7;

    const stockCode =
      getTag(
        block,
        "stock_code"
      )
        .trim()
        .padStart(6, "0");

    const corpCode =
      getTag(
        block,
        "corp_code"
      )
        .trim()
        .padStart(8, "0");

    const corpName =
      getTag(
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

  const payload =
    JSON.stringify(map);

  const cacheResponse =
    new Response(
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
  corpMapPromise
) {
  const code =
    normalizeCode(stockCode);

  const map =
    await corpMapPromise;

  const company =
    map[code];

  if (!company) {
    throw new Error(
      `종목코드 ${code}에 해당하는 기업을 DART에서 찾을 수 없습니다.`
    );
  }

  return {
    stock_code: code,
    corp_code:
      company.corp_code,
    corp_name:
      company.corp_name,
  };
}

/* =========================================================
   계정과목 검색
   ========================================================= */

function findAccount(
  items,
  patterns,
  sjDiv
) {
  const pats =
    patterns.map(normText);

  let rows = items;

  /*
   * 손익계산서:
   * IS 또는 CIS 모두 허용
   */
  if (sjDiv === "IS") {
    rows =
      items.filter(
        (x) =>
          x.sj_div === "IS" ||
          x.sj_div === "CIS"
      );
  } else if (sjDiv) {
    rows =
      items.filter(
        (x) =>
          x.sj_div === sjDiv
      );
  }

  /*
   * 1차: 정확히 일치
   */
  for (const row of rows) {
    const name =
      normText(
        row.account_nm
      );

    if (
      pats.some(
        (p) => name === p
      )
    ) {
      return row;
    }
  }

  /*
   * 2차: 포함
   */
  for (const row of rows) {
    const name =
      normText(
        row.account_nm
      );

    if (
      pats.some(
        (p) =>
          name.includes(p)
      )
    ) {
      return row;
    }
  }

  return null;
}

/*
 * 이자비용은 일반 금융비용 전체가 아니라
 * "이자비용" 계정 자체를 최대한 우선해서 찾는다.
 */
function findInterestExpense(
  items
) {
  const direct =
    findAccount(
      items,
      [
        "이자비용",
        "이자비용(금융원가)",
        "이자비용(이자비용)",
      ],
      "IS"
    );

  if (direct) {
    return direct;
  }

  /*
   * 계정명이 약간 다른 경우
   * "이자비용"이 포함되어 있고
   * "이자수익"은 아닌 항목을 찾는다.
   */
  const rows =
    items.filter(
      (x) =>
        x.sj_div === "IS" ||
        x.sj_div === "CIS"
    );

  for (const row of rows) {
    const name =
      normText(
        row.account_nm
      );

    if (
      name.includes(
        "이자비용"
      ) &&
      !name.includes(
        "이자수익"
      )
    ) {
      return row;
    }
  }

  return null;
}

function getAmount(
  row,
  field
) {
  if (!row) {
    return null;
  }

  return cleanNumber(
    row[field]
  );
}

/* =========================================================
   재무제표 API
   ========================================================= */

async function fetchFinancialStatement(
  corpCode,
  year,
  reportCode,
  fsDiv,
  env
) {
  return dartFetch(
    "fnlttSinglAcntAll",
    {
      corp_code: corpCode,
      bsns_year: String(year),
      reprt_code:
        reportCode,
      fs_div: fsDiv,
    },
    env
  );
}

/* =========================================================
   최근 3개 결산연도
   ========================================================= */

async function fetchAnnualYears(
  corpCode,
  env
) {
  const currentYear =
    new Date().getFullYear();

  const found = [];

  /*
   * 현재연도는 사업보고서가 아직 없을 수 있으므로
   * 전년도부터 최대 10년까지 과거로 내려가며
   * 실제 사업보고서 3개를 찾는다.
   */
  for (
    let year =
      currentYear - 1;
    year >=
      currentYear - 10;
    year--
  ) {
    let data = null;
    let fsDiv = "CFS";

    /*
     * 연결재무제표
     */
    try {
      data =
        await fetchFinancialStatement(
          corpCode,
          year,
          ANNUAL_REPORT,
          "CFS",
          env
        );

      if (
        !data?.list?.length
      ) {
        data = null;
      }
    } catch (e) {
      data = null;
    }

    /*
     * 연결이 없으면 별도재무제표
     */
    if (!data) {
      try {
        data =
          await fetchFinancialStatement(
            corpCode,
            year,
            ANNUAL_REPORT,
            "OFS",
            env
          );

        fsDiv = "OFS";

        if (
          !data?.list?.length
        ) {
          data = null;
        }
      } catch (e) {
        data = null;
      }
    }

    if (data) {
      found.push({
        year,
        items: data.list,
        fs_div: fsDiv,
      });
    }

    if (
      found.length >= 3
    ) {
      break;
    }
  }

  if (
    found.length < 3
  ) {
    throw new Error(
      "최근 3개 회계결산 재무제표를 확보하지 못했습니다."
    );
  }

  found.sort(
    (a, b) =>
      b.year - a.year
  );

  return found;
}

/* =========================================================
   결산 재무 데이터
   ========================================================= */

function extractAnnualFinancials(
  items
) {
  const revenue =
    findAccount(
      items,
      [
        "매출액",
        "수익(매출액)",
        "영업수익",
        "매출",
      ],
      "IS"
    );

  const netIncome =
    findAccount(
      items,
      [
        "당기순이익",
        "당기순이익(손실)",
        "당기순손익",
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
    findInterestExpense(
      items
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

  const revenueValue =
    getAmount(
      revenue,
      "thstrm_amount"
    );

  const previousRevenue =
    getAmount(
      revenue,
      "frmtrm_amount"
    );

  const netIncomeValue =
    getAmount(
      netIncome,
      "thstrm_amount"
    );

  const previousNetIncome =
    getAmount(
      netIncome,
      "frmtrm_amount"
    );

  const operatingCFValue =
    getAmount(
      operatingCF,
      "thstrm_amount"
    );

  const investingCFValue =
    getAmount(
      investingCF,
      "thstrm_amount"
    );

  const financingCFValue =
    getAmount(
      financingCF,
      "thstrm_amount"
    );

  const interestValue =
    getAmount(
      interestExpense,
      "thstrm_amount"
    );

  const operatingIncomeValue =
    getAmount(
      operatingIncome,
      "thstrm_amount"
    );

  /*
   * 이자보상배율 =
   * 영업이익 / 이자비용
   */
  const interestCoverage =
    calculateInterestCoverage(
      operatingIncomeValue,
      interestValue
    );

  return {
    revenue:
      revenueValue,

    previous_revenue:
      previousRevenue,

    net_income:
      netIncomeValue,

    previous_net_income:
      previousNetIncome,

    operating_cf:
      operatingCFValue,

    investing_cf:
      investingCFValue,

    financing_cf:
      financingCFValue,

    operating_income:
      operatingIncomeValue,

    interest_expense:
      interestValue,

    interest_coverage:
      interestCoverage,
  };
}

/* =========================================================
   분기 보고서
   ========================================================= */

const QUARTER_REPORTS = [
  {
    code: "11014",
    quarter: 3,
    name: "3분기",
  },
  {
    code: "11012",
    quarter: 2,
    name: "2분기",
  },
  {
    code: "11013",
    quarter: 1,
    name: "1분기",
  },
];

async function tryQuarterData(
  corpCode,
  year,
  reportCode,
  env,
  preferredFsDiv = null
) {
  const fsDivs =
    preferredFsDiv
      ? [
          preferredFsDiv,
          preferredFsDiv === "CFS"
            ? "OFS"
            : "CFS",
        ]
      : [
          "CFS",
          "OFS",
        ];

  for (
    const fsDiv of fsDivs
  ) {
    try {
      const data =
        await fetchFinancialStatement(
          corpCode,
          year,
          reportCode,
          fsDiv,
          env
        );

      if (
        data?.list?.length
      ) {
        return {
          year,
          report_code:
            reportCode,
          items: data.list,
          fs_div: fsDiv,
        };
      }
    } catch (e) {
      // 다음 재무제표 유형 시도
    }
  }

  return null;
}

/* =========================================================
   최근 실제 분기 자동 탐색
   ========================================================= */

async function fetchQuarterReport(
  corpCode,
  env
) {
  const currentYear =
    new Date().getFullYear();

  /*
   * 현재연도:
   * 3분기 → 2분기 → 1분기
   *
   * 없으면 전년도 같은 순서
   */
  for (
    let year =
      currentYear;
    year >=
      currentYear - 2;
    year--
  ) {
    for (
      const report of
        QUARTER_REPORTS
    ) {
      const current =
        await tryQuarterData(
          corpCode,
          year,
          report.code,
          env
        );

      if (!current) {
        continue;
      }

      /*
       * 동일한 분기의 전년 보고서
       */
      const previous =
        await tryQuarterData(
          corpCode,
          year - 1,
          report.code,
          env,
          current.fs_div
        );

      return {
        current,
        previous,
        quarter:
          report.quarter,
        quarter_name:
          report.name,
      };
    }
  }

  return null;
}

/* =========================================================
   분기 누적값 추출
   ========================================================= */

function getStatementValue(
  items,
  patterns,
  sjDiv
) {
  const row =
    findAccount(
      items,
      patterns,
      sjDiv
    );

  if (!row) {
    return null;
  }

  return {
    current:
      cleanNumber(
        row.thstrm_amount
      ),

    previous:
      cleanNumber(
        row.frmtrm_amount
      ),
  };
}

function getInterestStatementValue(
  items
) {
  const row =
    findInterestExpense(
      items
    );

  if (!row) {
    return null;
  }

  return {
    current:
      cleanNumber(
        row.thstrm_amount
      ),

    previous:
      cleanNumber(
        row.frmtrm_amount
      ),
  };
}

function extractQuarterCumulative(
  report
) {
  if (!report) {
    return null;
  }

  const items =
    report.items;

  const revenue =
    getStatementValue(
      items,
      [
        "매출액",
        "수익(매출액)",
        "영업수익",
        "매출",
      ],
      "IS"
    );

  const netIncome =
    getStatementValue(
      items,
      [
        "당기순이익",
        "당기순이익(손실)",
        "당기순손익",
      ],
      "IS"
    );

  const operatingIncome =
    getStatementValue(
      items,
      [
        "영업이익",
        "영업이익(손실)",
      ],
      "IS"
    );

  const interestExpense =
    getInterestStatementValue(
      items
    );

  return {
    revenue:
      revenue?.current ??
      null,

    net_income:
      netIncome?.current ??
      null,

    operating_income:
      operatingIncome?.current ??
      null,

    interest_expense:
      interestExpense?.current ??
      null,
  };
}

/* =========================================================
   계산
   ========================================================= */

function subtractValues(
  current,
  previous
) {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined
  ) {
    return null;
  }

  return current - previous;
}

function calculateInterestCoverage(
  operatingIncome,
  interestExpense
) {
  if (
    operatingIncome === null ||
    operatingIncome === undefined ||
    interestExpense === null ||
    interestExpense === undefined ||
    interestExpense === 0
  ) {
    return null;
  }

  return (
    operatingIncome /
    Math.abs(
      interestExpense
    )
  );
}

/* =========================================================
   실제 분기값 계산
   ========================================================= */

async function buildQuarterData(
  corpCode,
  year,
  quarter,
  report,
  env
) {
  const cumulative =
    extractQuarterCumulative(
      report
    );

  if (!cumulative) {
    return null;
  }

  /*
   * Q1
   * 누적값 자체가 Q1
   */
  if (
    quarter === 1
  ) {
    return {
      year,
      quarter,

      revenue:
        cumulative.revenue,

      net_income:
        cumulative.net_income,

      operating_income:
        cumulative.operating_income,

      interest_expense:
        cumulative.interest_expense,

      interest_coverage:
        calculateInterestCoverage(
          cumulative.operating_income,
          cumulative.interest_expense
        ),
    };
  }

  /*
   * Q2
   *
   * 상반기 누적 - 1분기 누적
   */
  if (
    quarter === 2
  ) {
    const q1 =
      await tryQuarterData(
        corpCode,
        year,
        "11013",
        env,
        report.fs_div
      );

    const q1Values =
      extractQuarterCumulative(
        q1
      );

    if (!q1Values) {
      return {
        year,
        quarter,
        revenue: null,
        net_income: null,
        operating_income:
          null,
        interest_expense:
          null,
        interest_coverage:
          null,
      };
    }

    const revenue =
      subtractValues(
        cumulative.revenue,
        q1Values.revenue
      );

    const netIncome =
      subtractValues(
        cumulative.net_income,
        q1Values.net_income
      );

    const operatingIncome =
      subtractValues(
        cumulative.operating_income,
        q1Values.operating_income
      );

    const interestExpense =
      subtractValues(
        cumulative.interest_expense,
        q1Values.interest_expense
      );

    return {
      year,
      quarter,

      revenue,

      net_income:
        netIncome,

      operating_income:
        operatingIncome,

      interest_expense:
        interestExpense,

      interest_coverage:
        calculateInterestCoverage(
          operatingIncome,
          interestExpense
        ),
    };
  }

  /*
   * Q3
   *
   * 3분기 누적 - 상반기 누적
   */
  if (
    quarter === 3
  ) {
    const h1 =
      await tryQuarterData(
        corpCode,
        year,
        "11012",
        env,
        report.fs_div
      );

    const h1Values =
      extractQuarterCumulative(
        h1
      );

    if (!h1Values) {
      return {
        year,
        quarter,
        revenue: null,
        net_income: null,
        operating_income:
          null,
        interest_expense:
          null,
        interest_coverage:
          null,
      };
    }

    const revenue =
      subtractValues(
        cumulative.revenue,
        h1Values.revenue
      );

    const netIncome =
      subtractValues(
        cumulative.net_income,
        h1Values.net_income
      );

    const operatingIncome =
      subtractValues(
        cumulative.operating_income,
        h1Values.operating_income
      );

    const interestExpense =
      subtractValues(
        cumulative.interest_expense,
        h1Values.interest_expense
      );

    return {
      year,
      quarter,

      revenue,

      net_income:
        netIncome,

      operating_income:
        operatingIncome,

      interest_expense:
        interestExpense,

      interest_coverage:
        calculateInterestCoverage(
          operatingIncome,
          interestExpense
        ),
    };
  }

  return null;
}

/* =========================================================
   최신 분기 데이터
   ========================================================= */

async function fetchLatestQuarter(
  corpCode,
  env
) {
  const found =
    await fetchQuarterReport(
      corpCode,
      env
    );

  if (!found) {
    return null;
  }

  const current =
    await buildQuarterData(
      corpCode,
      found.current.year,
      found.quarter,
      found.current,
      env
    );

  let previous = null;

  if (
    found.previous
  ) {
    previous =
      await buildQuarterData(
        corpCode,
        found.previous.year,
        found.quarter,
        found.previous,
        env
      );
  }

  return {
    current,
    previous,

    year:
      found.current.year,

    quarter:
      found.quarter,

    quarter_name:
      found.quarter_name,
  };
}

/* =========================================================
   최대주주
   ========================================================= */

async function fetchLargestShareholder(
  corpCode,
  year,
  env
) {
  /*
   * 최신 결산연도 우선
   */
  for (
    const y of [
      year,
      year - 1,
    ]
  ) {
    try {
      const data =
        await dartFetch(
          "hyslrSttus",
          {
            corp_code:
              corpCode,
            bsns_year:
              String(y),
            reprt_code:
              ANNUAL_REPORT,
          },
          env
        );

      const list =
        data?.list || [];

      let best = null;

      for (
        const row of list
      ) {
        const ratio =
          cleanNumber(
            row.trmend_posesn_stock_qota_rt
          );

        if (
          ratio === null
        ) {
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

            year: y,
          };
        }
      }

      if (best) {
        return best;
      }
    } catch (e) {
      // 이전 결산연도로 재시도
    }
  }

  return null;
}

/* =========================================================
   판정
   ========================================================= */

function judge(
  annuals,
  latestQuarter,
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

  const latestAnnual =
    annuals[0];

  const sortedAnnuals =
    annuals
      .slice()
      .sort(
        (a, b) =>
          a.year - b.year
      );

  /* =======================================================
     1. 매출액 증가
     ======================================================= */

  /*
   * 최근 3개 결산연도
   */
  const annualRevenueReady =
    sortedAnnuals.length === 3 &&
    sortedAnnuals.every(
      (x) =>
        x.financials.revenue !==
        null
    );

  let annualRevenueOk =
    false;

  if (
    annualRevenueReady
  ) {
    annualRevenueOk =
      sortedAnnuals[0]
        .financials.revenue <
        sortedAnnuals[1]
          .financials.revenue &&
      sortedAnnuals[1]
        .financials.revenue <
        sortedAnnuals[2]
          .financials.revenue;
  }

  /*
   * 최근분기 vs 전년동기
   */
  let quarterRevenueOk =
    false;

  let quarterGrowthRate =
    null;

  if (
    latestQuarter?.current?.revenue !==
      null &&
    latestQuarter?.current?.revenue !==
      undefined &&
    latestQuarter?.previous?.revenue !==
      null &&
    latestQuarter?.previous?.revenue !==
      undefined &&
    latestQuarter.previous.revenue !==
      0
  ) {
    quarterRevenueOk =
      latestQuarter.current.revenue >
      latestQuarter.previous.revenue;

    quarterGrowthRate =
      (
        (
          latestQuarter.current.revenue -
          latestQuarter.previous.revenue
        ) /
        Math.abs(
          latestQuarter.previous.revenue
        )
      ) *
      100;
  }

  /*
   * 두 조건을 모두 만족해야 양호.
   * 자료가 부족하면 최종적으로 불량 취급.
   */
  const revenueOk =
    annualRevenueReady &&
    quarterGrowthRate !== null &&
    annualRevenueOk &&
    quarterRevenueOk;

  let revenueValue =
    "자료없음";

  const annualRevenueText =
    annualRevenueReady
      ? sortedAnnuals
          .map(
            (x) =>
              `${x.year}년 ${formatNumber(
                x.financials.revenue
              )}`
          )
          .join(" → ")
      : "최근 3개 결산연도 자료없음";

  let quarterRevenueText =
    "최근분기 자료없음";

  if (
    latestQuarter?.current?.revenue !==
      null &&
    latestQuarter?.current?.revenue !==
      undefined
  ) {
    if (
      latestQuarter?.previous?.revenue !==
        null &&
      latestQuarter?.previous?.revenue !==
        undefined &&
      latestQuarter.previous.revenue !==
        0
    ) {
      quarterRevenueText =
        `${latestQuarter.year} Q${latestQuarter.quarter} ` +
        `${formatNumber(
          latestQuarter.current.revenue
        )} ` +
        `(전년동기 ${formatNumber(
          latestQuarter.previous.revenue
        )}, ${formatPercent(
          quarterGrowthRate
        )})`;
    } else {
      quarterRevenueText =
        `${latestQuarter.year} Q${latestQuarter.quarter} ` +
        `${formatNumber(
          latestQuarter.current.revenue
        )} ` +
        `(전년동기 자료없음)`;
    }
  }

  revenueValue =
    `${annualRevenueText} / ${quarterRevenueText}`;

  addResult(
    "revenue_growth",
    "매출액 증가",
    revenueValue,
    revenueOk
      ? "양호"
      : quarterGrowthRate === null ||
        !annualRevenueReady
        ? "자료없음"
        : "불량",
    "최근 3개 결산연도 매출액이 연속 증가하고 최근분기 매출액이 전년동기 대비 증가"
  );

  /* =======================================================
     2. 당기순이익 연속 적자
     ======================================================= */

  /*
   * 사용자 요구:
   * 최근 3개 결산연도 데이터를 모두 확보한 경우에만
   * 연속 적자를 분석한다.
   */

  const annualNetIncomeReady =
    sortedAnnuals.length === 3 &&
    sortedAnnuals.every(
      (x) =>
        x.financials.net_income !==
        null
    );

  let netIncomeOk =
    false;

  let netIncomeValue =
    "최근 3개 결산연도 자료없음";

  if (
    annualNetIncomeReady
  ) {
    let consecutiveLoss =
      0;

    let hasConsecutiveLoss =
      false;

    for (
      const annual of
        sortedAnnuals
    ) {
      if (
        annual.financials.net_income <
        0
      ) {
        consecutiveLoss++;

        if (
          consecutiveLoss >= 2
        ) {
          hasConsecutiveLoss =
            true;
        }
      } else {
        consecutiveLoss = 0;
      }
    }

    netIncomeOk =
      !hasConsecutiveLoss;

    netIncomeValue =
      sortedAnnuals
        .map(
          (x) =>
            `${x.year}년 ${formatNumber(
              x.financials.net_income
            )}`
        )
        .join(" / ");

    /*
     * 최근분기는 참고값으로 표시.
     * 기본 판정 자체는 최근 3개 결산 기준.
     */
    if (
      latestQuarter?.current?.net_income !==
        null &&
      latestQuarter?.current?.net_income !==
        undefined
    ) {
      netIncomeValue +=
        ` / 최근분기 ${latestQuarter.year} Q${latestQuarter.quarter} ` +
        `${formatNumber(
          latestQuarter.current.net_income
        )}`;
    }
  }

  addResult(
    "net_income",
    "당기순이익 연속 적자",
    netIncomeValue,
    !annualNetIncomeReady
      ? "자료없음"
      : netIncomeOk
        ? "양호"
        : "불량",
    "최근 3개 결산연도 데이터를 모두 확보하고 연속 2개년 이상 적자가 아니어야 함"
  );

  /* =======================================================
     3. 영업활동 CF
     ======================================================= */

  let operatingCFOk =
    false;

  if (
    latestAnnual?.financials
      ?.operating_cf !==
      null &&
    latestAnnual?.financials
      ?.operating_cf !==
      undefined
  ) {
    operatingCFOk =
      latestAnnual.financials
        .operating_cf > 0;
  }

  addResult(
    "operating_cf",
    "영업활동 현금흐름",
    latestAnnual?.financials
      ?.operating_cf !== null &&
    latestAnnual?.financials
      ?.operating_cf !== undefined
      ? formatNumber(
          latestAnnual.financials
            .operating_cf
        )
      : "자료없음",
    latestAnnual?.financials
      ?.operating_cf === null ||
    latestAnnual?.financials
      ?.operating_cf === undefined
      ? "자료없음"
      : operatingCFOk
        ? "양호"
        : "불량",
    "최근 결산 영업활동 현금흐름 > 0"
  );

  /* =======================================================
     4. 투자활동 CF
     ======================================================= */

  let investingCFOk =
    false;

  if (
    latestAnnual?.financials
      ?.investing_cf !==
      null &&
    latestAnnual?.financials
      ?.investing_cf !==
      undefined
  ) {
    investingCFOk =
      latestAnnual.financials
        .investing_cf < 0;
  }

  addResult(
    "investing_cf",
    "투자활동 현금흐름",
    latestAnnual?.financials
      ?.investing_cf !== null &&
    latestAnnual?.financials
      ?.investing_cf !== undefined
      ? formatNumber(
          latestAnnual.financials
            .investing_cf
        )
      : "자료없음",
    latestAnnual?.financials
      ?.investing_cf === null ||
    latestAnnual?.financials
      ?.investing_cf === undefined
      ? "자료없음"
      : investingCFOk
        ? "양호"
        : "불량",
    "최근 결산 투자활동 현금흐름 < 0"
  );

  /* =======================================================
     5. 재무활동 CF
     ======================================================= */

  let financingCFOk =
    false;

  if (
    latestAnnual?.financials
      ?.financing_cf !==
      null &&
    latestAnnual?.financials
      ?.financing_cf !==
      undefined
  ) {
    financingCFOk =
      latestAnnual.financials
        .financing_cf < 0;
  }

  addResult(
    "financing_cf",
    "재무활동 현금흐름",
    latestAnnual?.financials
      ?.financing_cf !== null &&
    latestAnnual?.financials
      ?.financing_cf !== undefined
      ? formatNumber(
          latestAnnual.financials
            .financing_cf
        )
      : "자료없음",
    latestAnnual?.financials
      ?.financing_cf === null ||
    latestAnnual?.financials
      ?.financing_cf === undefined
      ? "자료없음"
      : financingCFOk
        ? "양호"
        : "불량",
    "최근 결산 재무활동 현금흐름 < 0"
  );

  /* =======================================================
     6. 이자보상배율
     
     최근 3개 결산 + 최근분기
     
     계산:
       영업이익 / 이자비용
     
     판정:
       하나라도 자료없음 → 자료없음 + 불량
       하나라도 <= 1 → 위험 + 불량
       4개 모두 > 1 → 양호
     ======================================================= */

  const coveragePeriods =
    [];

  for (
    const annual of
      sortedAnnuals
  ) {
    coveragePeriods.push({
      label:
        `${annual.year}년`,

      value:
        annual.financials
          .interest_coverage,

      operating_income:
        annual.financials
          .operating_income,

      interest_expense:
        annual.financials
          .interest_expense,
    });
  }

  if (
    latestQuarter?.current
  ) {
    coveragePeriods.push({
      label:
        `${latestQuarter.year} Q${latestQuarter.quarter}`,

      value:
        latestQuarter.current
          .interest_coverage,

      operating_income:
        latestQuarter.current
          .operating_income,

      interest_expense:
        latestQuarter.current
          .interest_expense,
    });
  }

  const coverageMissing =
    coveragePeriods.length !== 4 ||
    coveragePeriods.some(
      (x) =>
        x.value === null ||
        x.value === undefined ||
        !Number.isFinite(
          Number(x.value)
        )
    );

  const coverageDanger =
    coveragePeriods.some(
      (x) =>
        x.value !== null &&
        x.value !== undefined &&
        Number.isFinite(
          Number(x.value)
        ) &&
        Number(x.value) <= 1
    );

  let interestCoverageStatus =
    "자료없음";

  let interestCoverageOk =
    false;

  if (
    coverageMissing
  ) {
    interestCoverageStatus =
      "자료없음";

    interestCoverageOk =
      false;
  } else if (
    coverageDanger
  ) {
    interestCoverageStatus =
      "위험";

    interestCoverageOk =
      false;
  } else {
    interestCoverageStatus =
      "양호";

    interestCoverageOk =
      true;
  }

  const coverageDetail =
    coveragePeriods
      .map((x) => {
        if (
          x.value === null ||
          x.value === undefined ||
          !Number.isFinite(
            Number(x.value)
          )
        ) {
          return `${x.label} 자료없음`;
        }

        return `${x.label} ${formatNumber(
          x.value
        )}배`;
      })
      .join(" / ");

  addResult(
    "interest_coverage",
    "이자보상배율",
    coverageDetail,
    interestCoverageStatus,
    "최근 3개 결산연도와 최근분기 모두 영업이익÷이자비용이 계산되고 모두 1배 초과"
  );

  /* =======================================================
     7. 최대주주
     ======================================================= */

  let shareholderOk =
    false;

  let shareholderStatus =
    "자료없음";

  if (
    shareholder &&
    shareholder.ratio !== null &&
    shareholder.ratio !== undefined
  ) {
    shareholderOk =
      shareholder.ratio >= 20;

    shareholderStatus =
      shareholderOk
        ? "양호"
        : "불량";
  }

  addResult(
    "largest_shareholder",
    "대주주 지분율",
    shareholder
      ? `${formatNumber(
          shareholder.ratio
        )}%`
      : "자료없음",
    shareholderStatus,
    "대주주 지분율 ≥ 20.0%"
  );

  /* =======================================================
     점수
     
     항상 7개 기준.
     
     자료없음/불량/위험 = 0점
     양호 = 1점
     ======================================================= */

  const values = [
    revenueOk,
    netIncomeOk,
    operatingCFOk,
    investingCFOk,
    financingCFOk,
    interestCoverageOk,
    shareholderOk,
  ];

  const passed =
    values.filter(
      (v) => v === true
    ).length;

  const missingCount =
    results.filter(
      (x) =>
        x.status ===
        "자료없음"
    ).length;

  return {
    results,

    derived: {
      /*
       * 차트에는 가장 최근분기의 이자보상배율 사용
       */
      interest_coverage:
        latestQuarter?.current
          ?.interest_coverage ??
        null,

      largest_shareholder_pct:
        shareholder
          ? shareholder.ratio
          : null,

      /*
       * 최근분기 매출 증감률
       */
      revenue_growth_rate:
        quarterGrowthRate,

      /*
       * 이자보상배율 4개 기간
       */
      interest_coverage_periods:
        coveragePeriods,
    },

    passed,

    /*
     * 항상 7개 기준
     */
    evaluated: 7,

    /*
     * 현재 index.html은 이 값이 0보다 크면
     * "제외"라고 표시하므로
     * 화면상 혼란을 피하기 위해 0으로 유지한다.
     *
     * 실제 누락 개수는 missing_count에 저장.
     */
    missing: 0,

    missing_count:
      missingCount,

    total_criteria: 7,

    score:
      `${passed}/7`,
  };
}

/* =========================================================
   개별 종목 분석
   ========================================================= */

async function analyzeOne(
  stockCode,
  env,
  ctx,
  corpMapPromise
) {
  const company =
    await resolveStock(
      stockCode,
      corpMapPromise
    );

  /*
   * 최근 3개 결산
   */
  const annualReports =
    await fetchAnnualYears(
      company.corp_code,
      env
    );

  const annuals =
    annualReports.map(
      (report) => ({
        year:
          report.year,

        fs_div:
          report.fs_div,

        financials:
          extractAnnualFinancials(
            report.items
          ),
      })
    );

  /*
   * 최근분기
   */
  const latestQuarter =
    await fetchLatestQuarter(
      company.corp_code,
      env
    );

  /*
   * 최대주주
   */
  const shareholder =
    await fetchLargestShareholder(
      company.corp_code,
      annuals[0].year,
      env
    );

  /*
   * 판정
   */
  const judgement =
    judge(
      annuals,
      latestQuarter,
      shareholder
    );

  return {
    ok: true,

    /*
     * 종목코드
     */
    stock_code:
      company.stock_code,

    /*
     * 종목명
     */
    corp_name:
      company.corp_name,

    /*
     * DART 기업코드
     */
    corp_code:
      company.corp_code,

    /*
     * 최근 결산연도
     */
    report_year:
      annuals[0].year,

    /*
     * 최근 3개 결산
     */
    annuals,

    /*
     * 최근분기 + 전년동기
     */
    latest_quarter:
      latestQuarter,

    /*
     * 최대주주
     */
    largest_shareholder:
      shareholder || {
        name: "-",
        ratio: null,
        year: null,
      },

    /*
     * 최종 판정
     */
    judgement,
  };
}

/* =========================================================
   Cloudflare Worker
   ========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      /*
       * DART API KEY 확인
       */
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

      /*
       * Health Check
       */
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

      /*
       * 분석 API
       */
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

        /*
         * 최대 10개
         */
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

        /*
         * 기업코드 XML은 한 번만 조회
         */
        const corpMapPromise =
          fetchCorpMap(
            env,
            ctx
          );

        /*
         * 종목별 독립 분석
         */
        const results =
          await Promise.all(
            codes.map(
              async (
                code
              ) => {
                try {
                  return await analyzeOne(
                    code,
                    env,
                    ctx,
                    corpMapPromise
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
              (x) =>
                x.ok
            ).length,

          failed:
            results.filter(
              (x) =>
                !x.ok
            ).length,

          results,
        });
      }

      /*
       * 정적 파일
       */
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
