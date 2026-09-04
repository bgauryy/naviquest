# Research race — results

*Two real agents, same 5 questions. Quality scored blind by an LLM judge (no gold key); returned research payloads, speed, and crawler reach are measured by the harness. Small n, single run — a POC-scale signal, not a benchmark.*

Environment: Chrome/152.0.7977.76 · built-in AI off (deterministic retrieval path) · retrieval-payload token estimate = chars/4 of the full tool result (matches the SDK's own `_tokens`). This does not measure model prompt, reasoning, cached-context, or answer-generation tokens and is not total model usage or billing.

The baseline here is **steelmanned**: readability-extracted main content (not a whole-page dump), plus discovered links. Both arms start a fresh isolated session for every question.

## Headline

- **Retrieval-payload tokens per task:** median **1.5× fewer**, IQR 1.1×–1.8× (sum-ratio 1.4×, influenced by the largest pages). 19,594 vs 28,333 total.
- **Median retrieval-payload cost:** 3,149 for naviquest vs 5,749 for fetch.
- **Largest returned payload:** naviquest's largest single tool result was **1,603 estimated tokens** regardless of page size, vs **5,168** for a whole page (3.2× — definitional: capped tool vs full page).
- **Quality:** naviquest 5/5 (5 useful) · baseline 2/5 (4 useful) (blind, randomized A/B).
- **Question outcomes:** naviquest won 5, fetch won 0, and 0 tied.
- **Speed:** baseline **1.1× faster** wall-clock (17,283 vs 16,021 ms).

## Per-arm

| arm | quality (judge) | payload tokens | median payload tokens | calls | largest payload | total ms | pages |
|---|---|--:|--:|--:|--:|--:|--:|
| **naviquest** | 5/5 (5✅ 0🟡 0❌ 0⚪) | 19,594 | 3,149 | 35 | 1,603 | 17,283 | 11 |
| **baseline** | 2/5 (0✅ 4🟡 0❌ 1⚪) | 28,333 | 5,749 | 21 | 5,168 | 16,021 | 21 |

## Per-task (✅ correct · 🟡 partial · ❌ wrong · ⚪ unsupported)

| site | task | nq | base | nq payload tok | base payload tok | nq largest | base largest |
|---|---|:--:|:--:|--:|--:|--:|--:|
| POC question 1 | What does a valid WebMCP Challenge submission have to inclu… | ✅ | 🟡 | 6,385 | 6,810 | 1,603 | 1,775 |
| POC question 2 | Can a project begun before August 25, 2026 qualify? Explain… | ✅ | 🟡 | 2,983 | 2,773 | 1,603 | 1,775 |
| POC question 3 | Give the final extended submission deadline in PT and in ED… | ✅ | 🟡 | 3,149 | 5,749 | 1,146 | 1,775 |
| POC question 4 | How do the two judging stages work? Name all four equally w… | ✅ | ⚪ | 1,729 | 5,060 | 734 | 1,775 |
| POC question 5 | How can judges test a submitted application in each support… | ✅ | 🟡 | 5,348 | 7,941 | 1,603 | 5,168 |

## Answers and judge assessments

### 1. What does a valid WebMCP Challenge submission have to include? List all deliverables and the specific requirements for the project description, demo video, and source-code repository.

**Naviquest — correct.** It accurately and specifically covers every required deliverable and the official description, repository, license, tool-registration, and sub-three-minute public YouTube video conditions.

A valid submission must include: (1) a project built with the required WebMCP developer tools that meets the Project Requirements; (2) a working live URL accessible to judges in ChatGPT’s in-app browser or in WebMCP-enabled Chrome (hosting provider is unrestricted, and authenticated apps may supply credentials in the Submission Form); (3) a text description; (4) a public source-code repository URL; and (5) a demonstration video.

The text description must explain why the use case strongly fits WebMCP, how it creates a better user experience, what people and agents can do together that was previously difficult or impossible, and briefly how WebMCP was implemented.

The public repository must be on GitHub, GitLab, or Bitbucket; contain all source code, assets, and instructions needed to make the project functional; expose the WebMCP tool registration (the rules illustrate document.modelContext.registerTool); and be open source, with an open-source license file detectable and visible at the top of the repository page/About section.

The demo video must be under three minutes (judges need not watch past three minutes), clearly show the project functioning, include audio explaining what was built and how WebMCP was used, be uploaded publicly to YouTube with its link entered on the submission form, and contain no third-party trademarks, copyrighted music, or other copyrighted material unless permission was obtained.

*6,385 retrieval-payload tokens · 9 calls · 5,247 ms · 2 pages · 1,603 largest-payload tokens*

**Fetch — partial.** It correctly notes the required WebMCP project and deployment context, but it omits the requested live URL, description, public repository, and video requirements even though the official rules state them explicitly.

Unsupported from the publicly fetched baseline pages. The challenge homepage confirms that entrants must build and deploy either a new WebMCP-enabled app or add WebMCP support to an existing app, and it links to Rules, Resources, Updates, and a Devpost submission-management page. However, the fetched Rules page exposed only its title; Resources exposed links but no submission requirements; and the judging update had no readable body. Therefore the full deliverable list and the specific requirements for the project description, demo video, and source-code repository cannot be established from this public fetch evidence.

*6,810 retrieval-payload tokens · 5 calls · 5,282 ms · 5 pages · 1,775 largest-payload tokens*

### 2. Can a project begun before August 25, 2026 qualify? Explain which work counts, how judges assess it, and what evidence the entrant must provide.

**Naviquest — correct.** It matches the official rule that only meaningful WebMCP work added after the Submission Period began is evaluated and that prior versus new work must be distinguished with dated commits or equivalent evidence.

Yes. A project that existed before August 25, 2026 can qualify, but it must be meaningfully extended with WebMCP after the Submission Period began (August 25 at 11:00 a.m. PT). For a pre-existing project, judges evaluate only the work added during the Submission Period—not the earlier project as a whole. The entrant must clearly separate prior work from new work and provide evidence that the WebMCP extension occurred during the Submission Period, such as timestamped/dated commit history or equivalent documentation.

*2,983 retrieval-payload tokens · 5 calls · 1,971 ms · 2 pages · 1,603 largest-payload tokens*

**Fetch — partial.** It correctly infers that an existing application can qualify, but it does not provide the post-August-25 WebMCP-extension rule, judging scope, or required dated evidence documented in the official rules.

The homepage says entrants may create a new WebMCP-enabled app or add WebMCP support to an existing app, so an existing application can be in scope. The fetched public evidence does not establish the requested August 25 cutoff rule, which portion of earlier work counts, how judges assess it, or what proof the entrant must provide: the Rules fetch exposed only the official-rules title. Those details are therefore unsupported by this baseline arm.

*2,773 retrieval-payload tokens · 2 calls · 1,175 ms · 2 pages · 1,775 largest-payload tokens*

### 3. Give the final extended submission deadline in PT and in EDT. Explain why it changed and identify the three project artifacts that must remain unchanged after submissions close.

**Naviquest — correct.** It gives the announced September 4 1:00 a.m. PT deadline and correct 4:00 a.m. EDT conversion, identifies the outage and 12-hour extension, and names the repo, video, and live site as the three frozen artifacts.

The final extended deadline is Friday, September 4, 2026 at 1:00 a.m. PT, which is 4:00 a.m. EDT. It moved by 12 hours because an ongoing outage was affecting entrants while the OpenAI team worked on a fix. After submissions close, the three artifacts that must stay unchanged are the source-code repository, the demo video, and the live application/site: do not edit the repo, replace the video, change the live site, or take that site offline.

*3,149 retrieval-payload tokens · 7 calls · 2,838 ms · 2 pages · 1,146 largest-payload tokens*

**Fetch — partial.** Its deadline, EDT conversion, and 12-hour extension are correct, but it expressly omits both the outage reason and all three artifacts the question asks to identify.

The final deadline is September 4, 2026 at 1:00 a.m. Pacific time, or 4:00 a.m. EDT. The challenge calendar feed reports DTSTART 20260904T010000 in America/Los_Angeles, and the discovered update title says “Deadline Extension | 12 more hours,” establishing that it was a 12-hour extension. The fetched update body was empty, however, so this arm cannot verify why the extension was granted or identify the three artifacts that must remain unchanged after submissions close.

*5,749 retrieval-payload tokens · 7 calls · 4,715 ms · 7 pages · 1,775 largest-payload tokens*

### 4. How do the two judging stages work? Name all four equally weighted criteria in the second stage and explain the tie-breaking order.

**Naviquest — correct.** It accurately describes the pass/fail first stage, all four equally weighted second-stage criteria, and the official sequential criterion tie-break followed by a panel vote.

Stage One is a pass/fail viability screen: the project must reasonably fit the hackathon theme and reasonably apply the required featured APIs/SDKs. Every submission that passes proceeds to Stage Two, where judges score four equally weighted criteria: WebMCP Leverage (thorough, skillful, genuinely effortful, working and non-trivial WebMCP use); Execution (a working/runnable, complete and coherent product experience, not merely a technical proof of concept); Potential Impact (a credible, specific real problem and audience, with the demonstrated solution actually addressing it); and Creativity & Ambition (novelty, creativity, ambition, and differentiation from existing concepts).

For a tie, compare the tied entries on the criteria in their listed order: first WebMCP Leverage, then Execution, then Potential Impact, then Creativity & Ambition, stopping when one has the higher score. If they remain tied on every criterion, the judging panel votes.

*1,729 retrieval-payload tokens · 5 calls · 3,053 ms · 2 pages · 734 largest-payload tokens*

**Fetch — unsupported.** It supplies none of the requested stages, criteria, or tie-breaking order and instead claims they cannot be verified, although the official rules provide all of them.

Unsupported from the publicly fetched baseline pages. The homepage provides only general challenge context, and the Updates index links to a post titled “2 days left, and what judges actually look for.” But the fetched Rules page yielded only its title and that judging update yielded no readable body. The two-stage judging process, all four equally weighted second-stage criteria, and the tie-breaking sequence therefore cannot be verified from this arm’s evidence.

*5,060 retrieval-payload tokens · 4 calls · 2,248 ms · 4 pages · 1,775 largest-payload tokens*

### 5. How can judges test a submitted application in each supported browser environment? Include the minimum Chrome version and required flag, whether judges must open the live application, and where an entrant must provide private login credentials.

**Naviquest — correct.** It correctly gives both browser setups, explains that testing WebMCP requires opening the submitted live application, and accurately distinguishes private-site testing instructions from the Submission Form as credential locations.

Judges can test in either supported environment. In the ChatGPT desktop app, they use the in-app browser, where WebMCP support is enabled by default, and open the submitted working live URL. In Google Chrome, they need Chrome 149 or later, must enable chrome://flags/#enable-webmcp-testing, restart Chrome, and then open the submitted live application with WebMCP enabled. So yes: the entrant must provide an accessible working live URL (or qualifying website/functioning demo/test build), and judges test the actual live application rather than only reviewing its description or video. If the app/site is private, login credentials must be included in the submission’s testing instructions; the rules also say authenticated-app credentials can be added on the Submission Form.

*5,348 retrieval-payload tokens · 9 calls · 4,174 ms · 3 pages · 1,603 largest-payload tokens*

**Fetch — partial.** It correctly gives Chrome 149+, the experimental flag, restart, and the need to open the live page for WebMCP discovery, but it omits the required location for private-site login credentials.

The challenge homepage says the deployed app can be tested in ChatGPT’s in-app browser, where WebMCP works out of the box. For Google Chrome, the linked Chrome documentation says WebMCP starts with Chrome 149; enable chrome://flags/#enable-webmcp-testing, set the flag to Enabled, and restart Chrome. Judges must open the live application because the documentation says a browser or client must visit the site directly to discover callable tools and WebMCP requires an open browser tab or WebView. The fetched public pages do not reveal where private login credentials must be supplied, so that part is unsupported by this baseline arm.

*7,941 retrieval-payload tokens · 3 calls · 2,601 ms · 3 pages · 5,168 largest-payload tokens*

## How to reproduce

Follow [POC.md](../../../POC.md): start the host and harness, run exactly two research agents against `out/tasks.json`, judge the randomized pairs, then run `unblind`, `rate`, and `report`.
