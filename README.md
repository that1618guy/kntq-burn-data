# kntq-burn-data

Data behind the KNTQ burn tracker at https://stateofblocks.com/dashboards/kntq-burn/.

`refresh.mjs` runs every 30 minutes (`.github/workflows/refresh.yml`) and rewrites `data.json`:

- **Sequencer fees per UTC day, exact.** The daily balance change of Elysium's fee account
  (`ArbOwnerPublic` network and infra fee account). That account has never sent a transaction, so its balance
  only grows. Each completed day is checked to the wei against receipts in random runs of consecutive blocks.
- **Ascend.** The KNTQ-burn leg per day in USD from DefiLlama, plus the burn treasury read from its splitter:
  holdings, buybacks, KNTQ paid in directly, and anything sent to a burn address.
- **Hyperliquid.** KNTQ and HYPE prices, KNTQ supply, the Assistance Fund's KNTQ and who sent it.

A source that fails keeps its previous value with that value's own timestamp. Nothing is filled with zero.
Run it yourself: `node refresh.mjs` (Node 18+, no dependencies).
