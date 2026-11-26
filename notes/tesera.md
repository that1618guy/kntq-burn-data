# Tesera (removed 2026-11-26)

Tesera was taken off the Elysium terminal on 2026-11-26 by the editor. These are the exact `sources.json` entries it had, so it can be put back as it was.

- Treasury: `0x0f4d74359142dcb648d9ce7d2d01f247ce4f9bfa`. It is an EOA with the same key on Elysium and HyperCore.
- First buy: tx `0x378687be93857677920bea1e9cd986b2654057c60dd0baadce33a6c0f323a909` on 2026-11-20 at 12:49 UTC. It paid 111.916592 HYPE and got 33,921.79 KNTQ.
- Kinetiq slug: `tesera-lab`.
- The code that reads it is generic and is still in `refresh.mjs`: `projects()` reads every `apps` wallet, and `knownSources()` credits it as an app source. No Tesera-specific code was removed.

## To restore

1. Delete the Tesera entry from `excludedProjects`.
2. Add the project back to `projects` and both wallets back to `apps`.
3. Expect about 2 slower runs: the known-source list changes `registryHash`, which re-traces every burn wallet.

## projects entry

```json
{
  "name": "Tesera",
  "commitment": "30% of fees, bought weekly and held",
  "kinetiq": "tesera-lab",
  "kind": "buy"
}
```

## apps entries

```json
[
  {
    "address": "0x0f4d74359142dcb648d9ce7d2d01f247ce4f9bfa",
    "chain": "elysium",
    "app": "Tesera",
    "label": "Tesera's treasury",
    "evidence": "Given by the State of Blocks editor 2026-11-20; first buyback tx 0x378687be93857677920bea1e9cd986b2654057c60dd0baadce33a6c0f323a909 (Elysium) pays from this address",
    "added": "2026-11-20"
  },
  {
    "address": "0x0f4d74359142dcb648d9ce7d2d01f247ce4f9bfa",
    "chain": "hypercore",
    "app": "Tesera",
    "label": "Tesera's treasury",
    "evidence": "Given by the State of Blocks editor 2026-11-20; first buyback tx 0x378687be93857677920bea1e9cd986b2654057c60dd0baadce33a6c0f323a909 (Elysium) pays from this address",
    "added": "2026-11-20"
  }
]
```

## Site

The logo was `dashboards/elysium/logos/tesera.webp` (from teseralab.com's icon-192). It was deleted from the site repo in the same change, and git history still has it.
