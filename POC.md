# WebMCP Challenge research race POC

This proof of concept compares two agents answering the same five questions
about the public WebMCP Challenge website. It measures answer quality, context
cost, call count, crawl reach, and wall-clock time. It does not assume either arm
wins.

Status: proposed and unmeasured.

## Shared starting point

Every question is an independent race and starts at:

[`https://webmcp.devpost.com/`](https://webmcp.devpost.com/)

Create a fresh agent context and browser or fetch session for each question.
Open the home URL before starting the timer, then include that open in the task's
measurements. Do not reuse page text, tool results, navigation history, or cached
responses from another question.

Give both agents the same start URL and question. Do not give either agent a
destination URL, page name, selector, search phrase, expected answer, excerpt,
or navigation advice.

## Questions

1. What does a valid WebMCP Challenge submission have to include? List all
   deliverables and the specific requirements for the project description, demo
   video, and source-code repository.
2. Can a project begun before August 25, 2026 qualify? Explain which work counts,
   how judges assess it, and what evidence the entrant must provide.
3. Give the final extended submission deadline in PT and in EDT. Explain why it
   changed and identify the three project artifacts that must remain unchanged
   after submissions close.
4. How do the two judging stages work? Name all four equally weighted criteria
   in the second stage and explain the tie-breaking order.
5. How can judges test a submitted application in each supported browser
   environment? Include the minimum Chrome version and required flag, whether
   judges must open the live application, and where an entrant must provide
   private login credentials.

## Agent arms

### Naviquest arm

- Use one WebMCP-enabled browser tab for the question.
- Use only `open` and Naviquest's six registered tools for research.
- Follow only links or addresses recovered from tool evidence.
- Do not use direct HTTP fetches, search-engine results, or prior knowledge as
  page evidence.

### Fetch arm

- Use only `fetch(url)` results containing extracted page text and links.
- Follow only links recovered from fetched pages.
- Do not use browser DOM tools, WebMCP tools, search-engine results, or prior
  knowledge as page evidence.

Use the same model, reasoning setting, timeout, token estimator, and question
order for both arms. Run both arms concurrently when the host can isolate their
sessions. Pin Naviquest's browser AI mode before the race and report the setting.

## Measurement

Record these values separately for every question and arm:

| Metric | Definition |
|---|---|
| Quality | A blind judge's `correct`, `partial`, `wrong`, or `unsupported` verdict |
| Tokens | `ceil(chars / 4)` over every complete tool-result JSON or fetch result visible to the agent |
| Calls | Number of measured tool calls or fetches, including the initial home-page open |
| Time | Sum of measured wall-clock milliseconds for all calls |
| Pages reached | Number of distinct URLs opened or fetched |
| Peak context | Largest single measured result in estimated tokens |

Calculate total and median token cost, total time, total calls, peak context,
quality score (`correct = 1`, `partial = 0.5`), and per-question wins and ties.
Report the raw values as well as ratios.

## Blind quality review

Randomize the two answers independently for each question and label them only
`A` and `B`. The judge receives the question, both answers, and an archived copy
of the public challenge evidence captured at the start of the run. Keep the arm
mapping hidden until all verdicts are complete.

The judge evaluates factual correctness, completeness, specificity, and support
from the captured website. An answer that refuses to answer because retrieval
failed is `unsupported`, even if the refusal is honest.

## Safety and validity

- Use public pages only.
- Do not log in, join the hackathon, open **My projects**, inspect participant
  profiles, post to discussions, or submit forms.
- Stop and mark the task blocked if the site requires authentication, presents a
  challenge, or prevents public navigation. Do not bypass the gate.
- Capture the rendered evidence and timestamp before the race. Challenge updates
  can supersede earlier rules or schedule text.
- Invalidate a question if the answer appears directly in its prompt or if one
  arm receives information unavailable to the other.

## Result table

| Arm | Quality | Tokens | Calls | Time | Pages reached | Peak context |
|---|---:|---:|---:|---:|---:|---:|
| Naviquest | — | — | — | — | — | — |
| Fetch | — | — | — | — | — | — |

Keep the full per-question call trace and answers with the result. A five-question
POC can demonstrate a mechanism or expose a failure, but it cannot establish a
universal quality, token, or speed claim.

Related documentation: [evaluation evidence](./docs/EVAL.md) and [research-race
methodology](./eval/research/METHODOLOGY.md).
