# Frontend Roadmap: Mission Control

## Status as of 2026-04-13

Branch: `frontend/mission-control` (based on `main` at `c720b0e`)

### What's done

1. **Component extraction** — the 1070-line monolithic `pool/[id]/page.tsx` has been broken into 9 reusable components in `src/components/`:
   - `badges.tsx` — 8 badge types with commercial-grade status language
   - `StatCard.tsx`, `UtilizationBar.tsx`, `TimeRemaining.tsx` — primitives
   - `ObligationTable.tsx` — full obligation table with redeem actions
   - `DelegationTable.tsx` — authority table with compliance + revoke
   - `ReserveCard.tsx` — reserve details panel
   - `TrackerStateCard.tsx` — tracker state with entry table
   - `SettlementHistory.tsx` — settlement event table
   - `index.ts` — barrel export

2. **Pool page rewrite** — `pool/[id]/page.tsx` now imports from `@/components` and is ~350 lines (page logic + delegation form) instead of 1070 lines (page logic + all inline components).

3. **Status language upgrade** — badges now use commercial states:
   - "Ready to Settle" instead of "Ready"
   - "Nearing Cap" / "Nearing Expiry" instead of "Approaching Cap"
   - "Outstanding" column header instead of "Balance"
   - "Reserve Backing" instead of "Reserve Value"
   - "+ Grant Authority" button instead of "+ New Delegation"

4. **Build passes** — `npx next build` succeeds with no errors.

5. **Storybook** — setup in progress (may need manual completion, see below).

### What's next (in priority order)

#### Phase 1: Component stories + visual polish

- [ ] Write Storybook stories for each extracted component (badges, tables, cards)
- [ ] If Storybook init didn't complete, run `npx storybook@latest init --yes` in `agent-tab/`
- [ ] Add Tailwind support to Storybook config (import `globals.css` in `.storybook/preview.ts`)
- [ ] Stories should cover key states: healthy/depleted pools, active/expired/exhausted delegations, ready/blocked obligations

#### Phase 2: Event timeline

- [ ] Create `EventTimeline.tsx` component — vertical timeline of pool events
- [ ] Event types: delegation_created, delegation_revoked, obligation_advanced, redemption_submitted, settlement_reconciled
- [ ] Replace or augment the flat `SettlementHistory` table on the pool page
- [ ] Source events from existing API data (settlements, delegations, obligations)

#### Phase 3: Detail drawer

- [ ] Create a slide-over `InspectorDrawer.tsx` component
- [ ] Clicking an obligation row opens drawer with: full state, signature history, proof references, linked delegation
- [ ] Clicking a delegation row opens drawer with: full authority grant details, agent info, spend history
- [ ] Replaces need to navigate to separate `/obligation/[id]` and detail pages for quick inspection

#### Phase 4: Overview page upgrade

- [ ] Redesign `/` (home) to show pools as primary objects, not providers/customers
- [ ] Each pool card: name, health badge, authority mode, reserve value, outstanding obligations, ready-to-settle count
- [ ] Add environment badge (testnet/local) to the top nav

#### Phase 5: Testing

- [ ] Add Playwright for e2e golden-path test (seed → view pool → create delegation → advance obligation → redeem)
- [ ] Playwright MCP can be used to drive the browser programmatically from Claude sessions
- [ ] Consider `@storybook/test-runner` for component-level visual regression

#### Phase 6: Future additions (not MVP)

- [ ] Per-agent authority envelope view
- [ ] Live event rail (right sidebar showing real-time pool activity)
- [ ] Relationship cards (provider-customer pair as visual cards)
- [ ] Multi-pool overview with cross-pool health
- [ ] Policy UI (eligibility rules, attestation requirements)
- [ ] Adapter/integration surface (identity source, display denomination, partner tags)

### Design principles (for any session picking this up)

1. **This is a control tower, not a dashboard.** The operator governs commercial relationships between agents, providers, and reserves.
2. **Meaning before mechanism.** Lead with "what happened" and "is it safe", not with tx IDs or box IDs.
3. **Status badges are the real UX.** The product lives or dies by how clearly states are communicated.
4. **Desktop-first.** Wide tables, multi-column layouts, side panels. Mobile comes later.
5. **No fintech cliches.** Don't make it look like Stripe, a crypto wallet, or a banking app.

### Technical notes

- All components are in `agent-tab/src/components/` with a barrel export at `index.ts`
- Types are co-located with their components and re-exported from the barrel
- The pool page data comes from a single API call: `GET /api/pool/summary?reserveId=X`
- Monetary values are BigInt nanoCredits — use `formatCredits()` from `@/lib/credits`
- Client-side signing uses `@noble/secp256k1` — see `@/lib/crypto`
- Storybook (if set up) runs on port 6006, independent of the Next.js dev server
