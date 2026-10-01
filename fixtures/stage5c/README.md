# Stage 5C evidence

All committed recordings/cases are synthetic contract fixtures. They contain no
real store, credential, IP, CDP endpoint or user directory. They are not proof of
business execution. Private runtime state and screenshots stay in ignored QA data.

- `copilot-baseline.json`: actual unchanged Copilot Describer results for nine
  existing scenarios plus twelve browser/e-commerce scenarios. Input/model/prompt
  hashes are frozen. Copilot cost is unavailable, not zero.
- `corpus.json`: exact synthetic cases, rubric and documented legacy context adapter.
- `model-eval.json`: actual provider + fixed OpenCode + production MCP outcomes,
  per-case scores, schema/references/confirmed facts, duration, tokens and cost.
- `model-attempts.json`: retained failures and early/subset trials, not cherry-picked
  as passing full evaluations. A pre-inference concurrent budget rejection can be
  continued serially on the exact unchanged case; that rejection remains recorded.
- `migration-policy.json`: derived only from the complete current-prompt receipt.
  Default migration also requires the checked provider configuration and stored key.
- `runtime-protocol.json`: real executable with a local deterministic provider,
  distinct from model quality. `runtime-cancel.json`: actual cancellation/retention.
- `windows-isolation.json`: actual OS canaries with reachable positive controls;
  **not** an OpenCode/npm/Playwright sandbox certificate.
- `credential-transfer.json`: authenticated metadata and real Windows vault roundtrip;
  the key and account balances are never exported.
- `provider-capabilities.json`: actual synthetic tool/structured/image probes. Unknown
  Vision withholds image tools; provider naming never substitutes for a probe.

Runtime: external OpenCode 1.18.29, reviewed Windows x64 SHA-256. The compatible
provider SDK is bundled by that pinned binary; no arbitrary provider package/plugin
is selected. Unreviewed code execution remains disabled.

Costs are peak-rate upper estimates, not invoices. Before each paid request the
entire cache-miss upper bound is reserved. Only valid numeric cached-token receipts
permit the configured cached rate; missing/invalid usage keeps the reserve. The
user-authorized batch limit is RMB 20 (USD 2.50 with a conservative ×8 ceiling),
including probes, unsuccessful requests and all trials. The ledger is never reset.

Reproduce deterministic tests with `npm run test:stage5c`. The real runtime checks
require the reviewed external executable. Paid model Eval requires an explicitly
authorized provider/key/price ceiling; no paid fallback or recharge is automatic.
No Builder, target index, login/Runner or Stage 6 implementation is included.
