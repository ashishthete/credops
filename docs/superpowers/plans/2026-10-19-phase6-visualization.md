# OpsDeck Phase 6: Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live topology map that is fun to use and never lies:
- A new **Map** section at `/map`. Products sit in the left column.
  Environments are framed groups in the middle, with their hosts packed
  inside. **This Mac** sits on the right.
- Host nodes show a role icon, the OS icon, a reachability dot, a live
  SSH session count, linked vault chips and a "via <jump>" chip. Jump
  hosts are drawn as edges.
- Tunnels are animated edges between This Mac and the host. Their
  direction follows traffic (`L` and `D` run Mac → host; `R` runs host →
  Mac). Colour follows state: green when up, amber while connecting or
  retrying, red when failed, muted when stopped. Dash speed and stroke
  width follow throughput.
- **Clicking:**
  - clicking a node opens a detail panel. Double-clicking a host connects;
  - clicking a tunnel edge opens its panel, which has a start/stop switch.
- **Filtering and search:**
  - filter by product or environment;
  - fuzzy search that dims non-matches, then zooms to the hit on Enter;
  - a minimap, zoom controls and fit-view.
- **Persistence:** the viewport is remembered per filter scope. Dragged
  positions are pinned for the session and can be reset.
- **Smooth transitions:** when the inventory changes, nodes glide to their
  new places, new nodes fade in and removed ones fade out.
- **Accessibility:**
  - a single tab stop with arrow-key navigation over the hierarchy;
  - a polite live region that names the focused node;
  - a **List** view that shows the same data as a plain table.
- **Reduced motion is honoured fully.** There is no dash flow, travelling
  dot, pulse, glide or animated zoom. State shows as colour and text alone.
- A data model with seams for Phase 8's app and deployment nodes.

**Architecture:**
- **Renderer only. No new IPC, no migration, no main-process change.** The
  map reads the existing stores:
  - `inventoryStore` (products, environments, hosts, vaults);
  - `tunnelStore` and `statsStore`;
  - `sessionStore`.
- **Pure modules carry the logic** under `src/renderer/src/map/`. Each is
  testable without React Flow:
  - `graph.ts`: `buildGraph` turns inventory, tunnel metas and a scope
    into typed nodes and edges;
  - `layout.ts`: deterministic coordinates plus a transition diff;
  - `presence.ts`: honest reachability from sessions and tunnels;
  - `search.ts`: fuzzy matching over node labels;
  - `keyboard.ts`: the focus model;
  - `viewport.ts`: per-scope viewport storage.
- **The structure is rebuilt only when it changes.** `buildGraph` and
  `layoutGraph` run when the inventory, the tunnel *metas* or the scope
  change. Runtime state, stats and sessions are read inside each node or
  edge component through per-id selector hooks. A stats tick therefore
  re-renders one edge label, never the graph.
- **React Flow is the canvas.**
  - Custom node types: `product`, `environment` (a group, parent of its
    hosts), `host` and `mac`.
  - Custom edge types: `tunnel`, `jump` and `membership`.
  - `MapPage` owns selection, filters, search, the panel and the view
    toggle.

**Tech Stack:** Phases 1–5, plus one new dependency:
- **`@xyflow/react` pinned to exactly `12.12.0`**, as a devDependency like
  every other renderer library. It was released 2026-09-24, so it is more
  than two weeks old, and it is the newest 12.x. `13.0.0-next.*` is a
  prerelease and is skipped. Its runtime dependencies are `zustand`,
  `classcat` and `@xyflow/system`. It is MIT.
- **No layout library.** The layout is hand-rolled in `layout.ts`, for
  these reasons:
  - the shape is a fixed hierarchy of three columns, with grid-packed
    groups. That is about 120 lines of arithmetic;
  - `elkjs` is about 8 MB, asynchronous, and wants a Web Worker. The CSP
    has no `worker-src`, and an asynchronous layout complicates the
    transitions;
  - `@dagrejs/dagre` handles compound (parent/child) graphs poorly, and
    environments are groups;
  - a deterministic, synchronous layout gives exact coordinates to assert
    on, stable positions across rebuilds, and transitions that only move
    what really moved.
- Framer Motion (already present) animates the panel and the node
  enter/leave. Position glides use a small `requestAnimationFrame` tween,
  because React Flow owns node transforms.

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md`:
- §3 G13 (topology map; tunnels as animated flowing edges in status
  colours; smooth transitions) and G1a (the map browses Product →
  Environment → Host);
- §5 anti-goals: a tunnel is never shown up while dead, and animation
  never blocks input;
- §6 the stack line (React Flow, Framer Motion);
- §7 resolution: a host's jump is `host.jumpHostId`, falling back to the
  environment's `defaultJumpHostId`;
- §8.1 the app opens locked, but lists and the map are visible;
- §8.5 map view;
- §10 feel (dark-first, ⌘K palette, springs, reduced motion).

The hooks left for later phases:
- §8.5 "apps attached to their host" and the Phase 8 deployment pipeline:
  - `MapNodeKind` is a union that Phase 8 extends with `app` and
    `deployment`;
  - host nodes already carry `attachments: MapAttachment[]` (always `[]`
    in Phase 6) and render them as a strip under the host;
  - `layoutGraph` already reserves space for attachments.

Roadmap and contracts: `docs/superpowers/plans/2026-10-16-roadmap.md`.
Conventions: the Phase 3–5 plans in the same folder.

## Global Constraints

- **All Phase 1–5 constraints still hold:**
  - the window flags and CSP. The CSP is unchanged: React Flow needs no
    worker and no eval, and its stylesheet is bundled by Vite;
  - the renderer imports no Node;
  - every IPC channel has a validator in `VALIDATORS`. This phase adds no
    channel. **If an implementer finds they need one, stop and raise it.**
    It needs a validator, a handler test and a plan amendment;
  - renderer mutations go through the existing store actions
    (`startTunnel`, `stopTunnel`, `connect`), which already wrap
    `attempt(...)`.
- **No new data is rendered.** The map shows only what the Products,
  Hosts and Tunnels pages already show:
  - product, environment and host names;
  - host addresses, roles, OS icons and tags;
  - vault *names*;
  - tunnel labels, bind and target addresses, states, error messages and
    rates;
  - session counts.

  It never shows identity usernames, key fingerprints, env-var values or
  host notes. These are already in `InventoryData` but are not passed into
  node data. *Pinned:* Task 1 `node data carries no private fields`.
- **Locked app.** The map renders while the vault is locked (§8.1).
  Connect and tunnel start go through the existing actions, which already
  raise the unlock flow.
- **The dependency is pinned exactly:** `"@xyflow/react": "12.12.0"` in
  `devDependencies`, with no caret. Import
  `@xyflow/react/dist/style.css` once, in `MapCanvas.tsx`. Theme it
  through CSS variables in `tokens.css` (`--xy-*`) so the canvas is
  dark-first.
- **Attribution.** Set `proOptions={{ hideAttribution: true }}`. The MIT
  licence allows this, and the default badge is an external link inside
  an offline app. The licence text ships with `node_modules` as usual.
- **Node and edge ids** are stable and derived. Tests and later phases
  rely on them:
  - product: `p:<productId>`;
  - environment group: `e:<envId>`;
  - the unassigned group: `u`;
  - host placement: `e:<envId>/h:<hostId>`, or `u/h:<hostId>` for a host
    in no environment;
  - this Mac: `mac`;
  - membership edge: `m:<productId>>e:<envId>`;
  - jump edge: `j:<sourcePlacementId>><targetPlacementId>`;
  - tunnel edge: `t:<tunnelId>`.
- **Layout constants** (in `layout.ts`, exported):
  - `HOST_W = 208`, `HOST_H = 64`, `ATTACH_H = 0` (Phase 8 makes this
    non-zero);
  - `GAP = 16`;
  - `GROUP_PAD = 16`, `GROUP_HEADER = 40`;
  - `MAX_COLS = 6`;
  - `PRODUCT_W = 200`, `PRODUCT_H = 56`, `MAC_W = 160`, `MAC_H = 72`;
  - `COL_GAP = 160`, `ROW_GAP = 48`.
- **Scope keys:** `all`, `p:<productId>` or `e:<envId>`. These are used
  in the URL (`/map?product=<id>&env=<id>`), as the viewport storage key
  and for the drag pins.
- **Presence is evidence only.** A host is green only on a `ready` SSH
  session or an `up` tunnel. The full rule is in Task 3. There is no
  ping and no background probe, because this phase adds no IPC.
- **Motion:**
  - Every looping or tweened animation is gated on `useMotionSafe()`:
    - the `od-flow` dashes;
    - the travelling dot;
    - the `od-pulse` on connecting nodes;
    - position glides;
    - `fitView` and `setCenter` durations;
    - the panel spring.
  - Under reduced motion every duration is `0` and the travelling dot is
    not rendered.
  - Animations never block input. Glides run in `requestAnimationFrame`,
    and a drag or click during a glide cancels it for that node.
- **Performance budget:**
  - `buildGraph` plus `layoutGraph` for 200 hosts in 12 environments
    takes under 50 ms in the test runner;
  - node components are `memo`;
  - `onlyRenderVisibleElements` is on when there are more than
    `VIRTUALIZE_AT = 120` nodes. jsdom's 0×0 viewport would hide
    everything otherwise, so tests stay below the threshold except in the
    one test that checks the flag;
  - stats ticks touch only the edge whose stats changed.
- **Storage:**
  - the viewport is in `localStorage` under `opsdeck.map.viewport`, as
    `{ [scopeKey]: { x, y, zoom } }`, capped at 32 scopes (least recently
    written dropped first);
  - every read and write is in `try/catch`, and the map works without
    storage;
  - **positions are not persisted.** The spec does not ask for it, and a
    deterministic layout makes it unnecessary. Drags pin a node in memory
    for the session, per scope, and **Reset layout** clears them.
- **Test stubs.** React Flow needs `ResizeObserver`, `DOMMatrixReadOnly`
  and element sizes, which jsdom lacks. They live in
  `tests/renderer/flow-stubs.ts`. Only the map tests import it, at the top
  of each file, and it is **not** added to the global `setup.ts`, so other
  suites keep jsdom's defaults. It installs:
  - `ResizeObserver`: a class whose `observe(el)` calls the callback at
    once with `[{ target: el, contentRect: { width, height } }]`, sized
    from `el.style`, falling back to 1000 × 800 for the flow wrapper.
    `unobserve` and `disconnect` are no-ops;
  - `DOMMatrixReadOnly`: a class whose constructor parses
    `scale(<n>)` / `matrix(a,b,c,d,e,f)` from the transform string, and
    exposes `m22` (and `a`, `d`). The default is the identity;
  - `HTMLElement.prototype.offsetWidth` and `offsetHeight` getters, which
    return `parseFloat(this.style.width || '1')` and the same for height,
    so measured nodes get their explicit size;
  - `SVGElement.prototype.getBBox`, returning
    `{ x: 0, y: 0, width: 0, height: 0 }`.

  Each stub is installed only when the global is missing, and the module
  is idempotent.
- **Section order.** `map` is inserted after `tunnels`:
  - products `mod+1`, terminals `mod+2`, hosts `mod+3`, vaults `mod+4`,
    tunnels `mod+5`, **map `mod+6`**, deployments `mod+7`, audit `mod+8`;
  - this shifts two existing shortcuts. The tests that assert the order
    are updated in Task 3.

## Review Focus

1. **A host never looks reachable without evidence.**
   - A host goes green only on a `ready` SSH session or an `up` tunnel.
   - A tunnel that drops from `up` to `retrying` turns the host and the
     edge amber in the same render.
   - A `failed` tunnel with no other evidence gives a red dot, and the
     text `Last connection failed`.
   - No evidence gives a grey dot and `Not checked`, never green.

   *Pinned:* Task 3 tests `presence is green only on a ready session or an
   up tunnel` and `a dropped tunnel turns its host amber`; Task 4 test
   `edge colour follows state and leaves green the moment a tunnel
   retries`.
2. **Stats ticks don't rebuild the graph or re-render other edges.**
   - A `tunnel:stats` event re-renders only that tunnel's edge label.
   - `buildGraph` and `layoutGraph` are not called again.
   - Other edges and every node keep their render count.

   *Pinned:* Task 4 test `a stats tick re-renders only its own edge`.
3. **Shared, filtered and dangling references never crash.**
   - A host in two environments is drawn once in each, marked `shared`.
   - An environment in two products sits under its primary product, with
     a secondary membership edge from the other.
   - A jump host outside the scope gives a "via" chip, not an edge.
   - A tunnel whose host is out of scope is omitted.
   - A tunnel whose environment no longer holds the host attaches to the
     host's first placement.
   - Deleting the selected or focused host closes the panel and moves the
     focus to its environment.

   *Pinned:* Task 1 tests `a shared host gets one placement per
   environment`, `a jump host outside the scope becomes a chip, not an
   edge`, `never emits an edge to a missing node`; Task 5 test `deleting
   the selected host closes its panel`.
4. **Reduced motion means no motion.** With `useMotionSafe() === false`:
   - no element has `od-flow` or `od-pulse`;
   - no `animateMotion` element exists;
   - `fitView` and `setCenter` are called with `duration: 0`;
   - an inventory change places nodes at their final positions in the same
     frame.

   *Pinned:* Task 4 `reduced motion stills every edge`; Task 6 `search
   zoom-to jumps under reduced motion`; Task 7 `reduced motion skips the
   glide`.
5. **200 hosts lay out fast and without overlap.**
   - No two host rectangles in the same group intersect.
   - No two groups intersect.
   - Every host lies inside its group.
   - The layout finishes inside the budget.

   *Pinned:* Task 2 test `200 hosts in 12 environments lay out without
   overlap in under 50 ms`.

Also pinned:
- Arrow keys walk product → environment → host and back, and Enter opens
  the panel (Task 8, `arrow keys walk the hierarchy`).
- The List view lists every host with the same reachability text (Task 8,
  `list view mirrors the map`).

## File map

```
package.json                                  @xyflow/react 12.12.0 exact (T3)
src/renderer/src/map/graph.ts                 MapNode/MapEdge types, buildGraph, scopes (T1)
src/renderer/src/map/layout.ts                layoutGraph, diffLayout, constants (T2)
src/renderer/src/map/presence.ts              hostPresence, useHostPresence (T3)
src/renderer/src/map/useMapGraph.ts           memoised build+layout from stores (T3)
src/renderer/src/map/nodes.tsx                ProductNode, EnvironmentNode, HostNode, MacNode (T3)
src/renderer/src/map/edges.tsx                TunnelEdge, JumpEdge, MembershipEdge (T4)
src/renderer/src/map/MapCanvas.tsx            ReactFlow wiring, minimap, controls (T3, T4, T6, T7)
src/renderer/src/map/DetailPanel.tsx          host / environment / product / tunnel panels (T5)
src/renderer/src/map/search.ts                searchGraph (T6)
src/renderer/src/map/viewport.ts              per-scope viewport storage (T6)
src/renderer/src/map/useGraphTransition.ts    glide, enter, leave (T7)
src/renderer/src/map/keyboard.ts              focus model, nextFocus (T8)
src/renderer/src/map/MapList.tsx              list alternative (T8)
src/renderer/src/map/commands.ts              palette commands (T8)
src/renderer/src/pages/map/MapPage.tsx        page: toolbar, filters, search, panel, view toggle (T3, T5, T6, T8)
src/renderer/src/shell/sections.ts            + map section (T3)
src/renderer/src/shell/AppShell.tsx           + /map route, useMapCommands (T3, T8)
src/renderer/src/shell/Sidebar.tsx            + Network icon (T3)
src/renderer/src/ui/tokens.css                --xy-* theme, od-travel, node enter (T3, T4)
src/renderer/src/pages/products/EnvironmentView.tsx, ProductView.tsx  "Show on map" (T8)
src/renderer/src/pages/hosts/HostView.tsx     "Show on map" (T8)
tests/renderer/flow-stubs.ts                  ResizeObserver, DOMMatrixReadOnly, sizes, getBBox (T3)
tests/renderer/map-*.test.ts(x)               per task
```

---

### Task 1: Graph model: `buildGraph`, scopes, placements, jumps and tunnel direction

**Files:**
- Create: `src/renderer/src/map/graph.ts`.
- Test: `tests/renderer/map-graph.test.ts` (new; pure, no DOM needed).

**Interfaces:**
- Produces, in `graph.ts`:
  - `type MapScope = { kind: 'all' } | { kind: 'product'; productId: string } | { kind: 'environment'; environmentId: string }`;
  - `scopeKey(scope): string` gives `all`, `p:<id>` or `e:<id>`, and
    `parseScope(params: URLSearchParams, data: InventoryData): MapScope`.
    `env` wins over `product`. An unknown id falls back to `all`;
  - `type MapNodeKind = 'product' | 'environment' | 'host' | 'mac'`. The
    comment says Phase 8 adds `'app' | 'deployment'`;
  - `interface MapAttachment { id: string; kind: string; label: string }`.
    This is the Phase 8 seam, and it is always empty here;
  - the node data types:
    - `ProductNodeData`: `{ kind: 'product'; productId; name; color; icon; environmentCount }`;
    - `EnvironmentNodeData`: `{ kind: 'environment'; environmentId: string | null; name; color; protected: boolean; hostCount: number; productNames: string[] }`.
      `environmentId` is `null` for the unassigned group;
    - `HostNodeData`: `{ kind: 'host'; hostId; environmentId: string | null; label; address; role: HostRole | null; osIcon; tags: string[]; vaultNames: string[]; sharedCount: number; jumpLabel: string | null; attachments: MapAttachment[] }`.
      `sharedCount` is the number of placements of this host in the whole
      inventory. `jumpLabel` is set only when the jump host is **not**
      drawn as an edge in this scope;
    - `MacNodeData`: `{ kind: 'mac'; tunnelCount: number }`;
  - `type MapNodeData = ProductNodeData | EnvironmentNodeData | HostNodeData | MacNodeData`;
  - `interface MapNode { id: string; parentId?: string; data: MapNodeData }`.
    It has no position. Layout adds that;
  - the edge data types:
    - `MembershipEdgeData`: `{ kind: 'membership'; primary: boolean }`;
    - `JumpEdgeData`: `{ kind: 'jump'; viaEnvDefault: boolean }`;
    - `TunnelEdgeData`: `{ kind: 'tunnel'; tunnelId; tunnelType: TunnelType; label: string }`;
  - `interface MapEdge { id; source; target; data: MembershipEdgeData | JumpEdgeData | TunnelEdgeData }`;
  - `interface MapGraph { nodes: MapNode[]; edges: MapEdge[]; placementsByHost: Record<string, string[]> }`;
  - `buildGraph(input: { data: InventoryData; tunnels: TunnelMeta[]; scope: MapScope }): MapGraph`.
    It is pure and deterministic. Nodes are ordered:
    1. products by name;
    2. then each group followed by its hosts, ordered by `ROLE_ORDER` and
       then by label;
    3. then `mac`.
- Consumes:
  - `InventoryData` from `inventory/store.ts`;
  - `environmentKey` and `ROLE_ORDER` from `inventory/tree.ts`;
  - `TunnelMeta` from `shared/tunnels.ts`.

**Behaviour:**
- **Scope:**
  - `all` includes every product, every environment and the unassigned
    group;
  - a product scope includes that product, its environments and their
    hosts;
  - an environment scope includes that environment, its products (as the
    left column) and its hosts. The unassigned group is never included in
    a product or environment scope.
- **Primary product.** Each environment is placed once. Its primary
  product is the one `environmentKey(env)` picks (first by sorted id),
  restricted to the products in scope.
  - The primary product gets a `membership` edge with `primary: true`.
  - Every other in-scope product gets `primary: false`.
  - An environment with no product goes into the unassigned group's
    column with no membership edge.
- **Unassigned group `u`.** It holds hosts that belong to no
  environment. It is only emitted when it has at least one host. An
  environment with no product is its own group, with no product edge.
- **Host placements.** There is one node per `(environment, host)`
  membership, with `parentId` set to its group. `role` comes from the
  membership; it is `null` for unassigned hosts.
- **Jump edges:**
  - The jump is `host.jumpHostId ?? env.defaultJumpHostId` for that
    placement's environment. `viaEnvDefault` is true when it came from the
    environment.
  - The source is the jump host's placement in the same environment if it
    has one, otherwise its first placement in scope, by node order.
  - When the jump host has no placement in scope, there is no edge, and
    `jumpLabel` is the jump host's label.
  - A self-jump or a missing jump host gives neither an edge nor a chip.
- **Tunnel edges:**
  - The host end is the placement for `tunnel.environmentId` if it is in
    scope, otherwise the host's first placement in scope. The tunnel is
    omitted when the host has no placement in scope.
  - The direction follows traffic: `L` and `D` give `source: 'mac'` and a
    host target; `R` gives a host source and `target: 'mac'`.
  - `mac` is emitted only when at least one tunnel edge exists.
- **Vault names** are resolved from `data.vaults` by id. Unknown ids are
  skipped.

- [ ] **Step 1: Write the failing tests** (`tests/renderer/map-graph.test.ts`, built from the `helpers.tsx` fixtures)
- `builds products, environment groups and host placements`:
  - one product, two environments, three hosts;
  - the node ids are exactly
    `['p:p1', 'e:e1', 'e:e1/h:h1', 'e:e1/h:h2', 'e:e2', 'e:e2/h:h3']`;
  - each host node's `parentId` is its group.
- `orders hosts by role, then label`: bastion, then app, then db, then
  other.
- `a shared host gets one placement per environment`:
  - `h1` is in `e1` and `e2`, so there are two nodes;
  - both have `sharedCount: 2`.
- `an environment in two products sits under its primary product only`:
  - there is one `e:e1` node;
  - `m:pA>e:e1` has `primary: true` and `m:pB>e:e1` has
    `primary: false`.
- `hosts in no environment land in the unassigned group`: the node `u`
  and the node `u/h:h9`. There is no `u` when every host is placed.
- `jump resolves host first, then environment default`:
  - `h2.jumpHostId = h1` gives `j:e:e1/h:h1>e:e1/h:h2` with
    `viaEnvDefault: false`;
  - when only `env.defaultJumpHostId = h1`, the edge has
    `viaEnvDefault: true`;
  - the bastion itself gets no self-edge.
- `a jump host outside the scope becomes a chip, not an edge`: with an
  environment scope, a jump host from another environment gives
  `jumpLabel: 'bastion'` and no `j:` edge.
- `tunnel direction follows traffic`:
  - `L` gives `{ source: 'mac', target: 'e:e1/h:h1' }`;
  - `R` gives `{ source: 'e:e1/h:h1', target: 'mac' }`;
  - `D` is the same as `L`.
- `a tunnel attaches to its environment's placement`:
  - a shared host with a tunnel in `e2` targets `e:e2/h:h1`;
  - with `environmentId: null` it targets the first placement.
- `a tunnel whose host is out of scope is omitted`, and `mac` is absent
  when no tunnels remain.
- `product scope keeps only that product's environments`.
- `environment scope shows the environment and all its products`.
- `parseScope prefers env and falls back to all on unknown ids`.
- `never emits an edge to a missing node`: a property-style loop over 50
  random inventories (seeded), with random scopes. Every edge's source
  and target exist in `nodes`, and every `parentId` exists.
- `node data carries no private fields`:
  - `JSON.stringify(graph)` contains no identity username, no env-var
    value and no host notes from the fixtures;
  - the fixtures set these to sentinel strings.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-graph.test.ts`
Expected: FAIL. `src/renderer/src/map/graph.ts` doesn't exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): pure graph model with scopes, placements, jumps and tunnel direction`

---

### Task 2: Deterministic layout and the transition diff

**Files:**
- Create: `src/renderer/src/map/layout.ts`.
- Test: `tests/renderer/map-layout.test.ts` (new; pure).

**Interfaces:**
- Produces, in `layout.ts`:
  - the constants from Global Constraints, plus `VIRTUALIZE_AT = 120`;
  - `interface Placed { id; x: number; y: number; width: number; height: number }`.
    Child coordinates are relative to the parent, as React Flow expects;
  - `interface MapLayout { positions: Record<string, Placed>; bounds: { width; height } }`;
  - `layoutGraph(graph: MapGraph, pins?: Record<string, { x: number; y: number }>): MapLayout`.
    It is pure and deterministic;
  - `diffLayout(prev: MapLayout | null, next: MapLayout): { entering: string[]; leaving: string[]; moved: string[] }`.
    `moved` means the position changed by more than 0.5 px. Size changes
    count as moved.

**Behaviour:**
- **Groups:**
  - a group with `n` hosts has `cols = min(MAX_COLS, max(1, ceil(sqrt(n))))`
    and `rows = ceil(n / cols)`;
  - width is `2·GROUP_PAD + cols·HOST_W + (cols−1)·GAP`;
  - height is `GROUP_HEADER + GROUP_PAD + rows·(HOST_H + ATTACH_H) + (rows−1)·GAP`;
  - an empty group is one host cell wide and shows "No hosts";
  - hosts fill row by row, in node order.
- **Columns:**
  - column 0 holds the products;
  - column 1 holds the groups. Groups are stacked vertically in product
    order: the primary-product groups under each product, then groups with
    no product, then `u`. `ROW_GAP` separates them;
  - each product is centred vertically on the span of its primary groups.
    A product with no groups is stacked after the previous one;
  - column 2 holds `mac`. It is centred vertically on the hosts that have
    tunnel edges, and placed `COL_GAP` right of the widest group.
- **Pins.** A pinned node uses the pinned position. Pins on hosts are
  relative to the group and clamped inside it. Other nodes are not
  re-flowed around pins.
- Every node gets explicit `width` and `height`, so React Flow never
  needs to measure before it can draw edges.

- [ ] **Step 1: Write the failing tests** (`tests/renderer/map-layout.test.ts`)
- `packs four hosts in a 2×2 grid inside the group`: exact `x` and `y`
  for each host, and the exact group width and height.
- `caps columns at six`: 50 hosts give 6 columns and 9 rows.
- `stacks groups under their primary product and centres the product`.
- `places this Mac right of the widest group, centred on tunnelled hosts`.
- `is deterministic`: the same graph twice gives deep-equal layouts.
- `an unrelated host added elsewhere does not move existing groups above
  it`.
- `pins override computed positions and are clamped inside the group`.
- `diffLayout reports entering, leaving and moved`:
  - add one host, remove one host and move one group;
  - assert exactly those three ids, in the right lists.
- `200 hosts in 12 environments lay out without overlap in under 50 ms`:
  - generate the inventory with a seed, then `buildGraph` and
    `layoutGraph`;
  - assert no intersecting host rectangles within a group, no
    intersecting groups, and every host inside its group's box;
  - time `performance.now()` around build plus layout and assert under
    50 ms. Take the best of 3 runs to avoid CI noise.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-layout.test.ts`
Expected: FAIL. `layout.ts` doesn't exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): deterministic column layout with grid-packed groups and a transition diff`

---

### Task 3: Dependency, test stubs, presence, the Map section and the canvas with custom nodes

**Files:**
- Create:
  - `tests/renderer/flow-stubs.ts`;
  - `src/renderer/src/map/presence.ts`;
  - `src/renderer/src/map/useMapGraph.ts`;
  - `src/renderer/src/map/nodes.tsx`;
  - `src/renderer/src/map/MapCanvas.tsx`;
  - `src/renderer/src/pages/map/MapPage.tsx`.
- Modify:
  - `package.json` and `pnpm-lock.yaml`: add `"@xyflow/react": "12.12.0"`
    to `devDependencies`, using
    `~/Library/pnpm/bin/pnpm add -D --save-exact @xyflow/react@12.12.0`;
  - `src/renderer/src/shell/sections.ts`: add
    `{ id: 'map', label: 'Map', path: '/map' }` after `tunnels`;
  - `src/renderer/src/shell/Sidebar.tsx`: `SECTION_ICONS.map = Network`;
  - `src/renderer/src/shell/AppShell.tsx`: the `/map` route;
  - `src/renderer/src/ui/tokens.css`:
    - the `--xy-*` variables (background, node, edge, minimap and
      controls colours from the existing tokens);
    - `.od-node-enter`, a 160 ms fade and scale from 0.96;
    - `.react-flow__node:focus-visible` uses the app focus ring.
- Test:
  - `tests/renderer/map-presence.test.ts` (new);
  - `tests/renderer/map-page.test.tsx` (new);
  - `tests/renderer/shell.test.tsx`: `mod+7 jumps to Audit` becomes
    `mod+8 jumps to Audit`, the shortcut list gains `mod+8`, and add
    `mod+6 opens Map`;
  - `tests/renderer/terminals-page.test.tsx:112`: the section id list
    gains `'map'` after `'tunnels'`.

**Interfaces:**
- `flow-stubs.ts`: side-effect import, as specified in Global
  Constraints.
- In `presence.ts`:
  - `type Reach = 'ok' | 'busy' | 'bad' | 'unknown'`;
  - `REACH_TEXT: Record<Reach, string>` =
    `{ ok: 'Reachable', busy: 'Connecting', bad: 'Last connection failed', unknown: 'Not checked' }`;
  - `hostPresence(hostId: string, sessions: SessionMeta[], tunnels: TunnelMeta[], runtime: Record<string, TunnelRuntime>): { sessions: number; reach: Reach }`.
    It is pure;
  - `useHostPresence(hostId)` subscribes to `sessionStore` and
    `tunnelStore` through `useSyncExternalStore`. Its snapshot is cached
    by value (`sessions` plus `reach`), so unrelated changes don't
    re-render.
- In `useMapGraph.ts`: `useMapGraph(scope: MapScope, pins): { graph: MapGraph; layout: MapLayout } | null`.
  - It reads `useInventory()` and the tunnel **metas** only. That is a
    selector on `tunnelStore` that returns the same array reference until
    the metas change.
  - It memoises on `(data, metas, scopeKey, pins)`.
  - It returns `null` while the inventory is not loaded.
- `nodes.tsx` exports `nodeTypes = { product, environment, host, mac }`,
  each `memo`'d.
- `MapCanvas` props: `{ graph; layout; selectedId; dimmed: Set<string> | null; highlightId: string | null; onSelect(id: string | null); onActivate(id: string); onEdgeSelect(id: string) }`.
  It builds React Flow `Node[]` and `Edge[]` from `graph` plus `layout`.
  Tasks 4–8 extend it.

**Behaviour:**
- **Presence rule.** These are evaluated in order, and the first match
  wins:
  1. any session for the host in `ready`, or any tunnel on the host in
     `up`, gives `ok`;
  2. any session in `connecting`, or any tunnel in `connecting` or
     `retrying`, gives `busy`;
  3. any session in `failed`, or any tunnel in `failed`, gives `bad`;
  4. otherwise `unknown`.

  The session count is the number in `connecting` or `ready`.
- **Nodes:**
  - **`ProductNode`:** a pill in the product colour, with its lucide icon,
    the name and `3 environments`.
  - **`EnvironmentNode`:**
    - a framed group with the environment colour as a 3 px top edge and a
      soft tint;
    - a header with `GlowDot`, the name, the protected lock badge and the
      host count;
    - when it belongs to several products, a muted line
      `also in Billing, Ops`;
    - the unassigned group is dashed and grey, titled `Unassigned`.
  - **`HostNode`:**
    - the role icon (bastion `ShieldCheck`, app `AppWindow`, db
      `Database`, other `Server`), with `ROLE_LABEL` as its title, and the
      OS icon from `OS_META`;
    - the label and, in mono, the address;
    - the reachability dot, with `aria-label` from `REACH_TEXT`. The dot
      uses `od-pulse` when `busy`;
    - a session badge (`SquareTerminal` and the count) when the count is
      above 0;
    - vault chips, at most 2 then `+n`;
    - a `shared ×2` chip when `sharedCount > 1`;
    - a `via bastion` chip when `jumpLabel` is set;
    - an empty attachments strip, rendered only when `attachments` has
      items (Phase 8);
    - handles: target on the left, source on the right, both hidden (no
      user connecting);
    - hovering lifts the node with a shadow, and `selected` gives an
      accent ring.
  - **`MacNode`:** a `Laptop` icon, `This Mac` and `2 tunnels`.
- **Canvas:**
  - `<ReactFlow>` with these props:
    - `nodesConnectable={false}`, `elementsSelectable`;
    - `nodesFocusable={false}`, `edgesFocusable={false}` (Task 8 owns
      keyboard);
    - `minZoom={0.2}`, `maxZoom={2}`;
    - `fitView` on first mount when no viewport is stored (Task 6 adds
      storage);
    - `proOptions={{ hideAttribution: true }}`;
    - `onlyRenderVisibleElements={nodes.length > VIRTUALIZE_AT}`;
    - `colorMode="dark"`.
  - Children:
    - `<Background variant="dots" />`;
    - `<MiniMap pannable zoomable nodeColor={…} />`, coloured by
      environment, with groups at low opacity;
    - `<Controls showInteractive={false} />`.
  - `selectedId` drives `selected` on the matching node.
  - `onNodeClick` calls `onSelect`, and `onPaneClick` calls
    `onSelect(null)`.
- **Page:**
  - a header with `Map` (h1), a summary
    `4 environments · 23 hosts · 3 tunnels up`, and a toolbar row (filled
    in by Tasks 6 and 8);
  - while the inventory is `null`: a `Skeleton` canvas;
  - with no hosts and no products: `EmptyState` with a `Network` icon, the
    title `Nothing to map yet`, the text
    `Add hosts and they appear here, grouped by environment.` and the
    actions **Add host** (`/hosts?action=new`) and **Import from ssh
    config** (`/hosts?action=import`).
- **Routing:** `/map` renders `MapPage` inside the existing animated
  route wrapper.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/map-presence.test.ts`:
- `presence is green only on a ready session or an up tunnel`: a table
  test over every combination of session states and tunnel states.
  - `ok` appears only in rows with `ready` or `up`.
  - `connecting` alone gives `busy`.
  - `failed` alone gives `bad`.
  - `closed` and `stopped` give `unknown`.
- `a dropped tunnel turns its host amber`: the runtime goes from `up` to
  `retrying`, and reach goes from `ok` to `busy`.
- `counts only live sessions`: a `closed` session is not counted.
- `useHostPresence ignores other hosts`: a session change on another
  host does not re-render. Use a render counter.

`tests/renderer/map-page.test.tsx` (imports `./flow-stubs` first, uses
`renderShell('/map')` with `mockBridge`):
- `mod+6 opens the Map`: the heading `Map` and the sidebar link
  `aria-current`.
- `renders groups and hosts inside them`:
  - `.react-flow__node[data-id="e:e1"]` exists;
  - `[data-id="e:e1/h:h1"]` exists and contains `web` and its address.
- `host shows role, OS and reachability text`:
  - the title `Database`;
  - the dot `aria-label` `Not checked`;
  - after a `session` store update to `ready`, it reads `Reachable`.
- `a shared host shows its shared chip in both groups`.
- `a jump host outside the filter shows a via chip`.
- `this Mac appears only when there are tunnels`.
- `minimap and controls render; attribution is hidden`:
  - `.react-flow__minimap` and `.react-flow__controls` exist;
  - `.react-flow__attribution` does not.
- `virtualizes past 120 nodes`: with 130 hosts, a spy on the `ReactFlow`
  export receives `onlyRenderVisibleElements: true`, and `false` with 10
  hosts. This test lives in its own file,
  `tests/renderer/map-virtualize.test.tsx`, because it mocks
  `@xyflow/react` through `vi.mock` with `importOriginal`.
- `empty state offers add and import`.
- `loading shows a skeleton`.
- `renders while the vault is locked`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-presence.test.ts tests/renderer/map-page.test.tsx tests/renderer/shell.test.tsx tests/renderer/terminals-page.test.tsx`
Expected: FAIL. There is no `presence.ts`, no `/map` route and no
`map` section. The shortcut and section-list assertions fail.

- [ ] **Step 3: Implement**

Install the dependency first. Then check that `pnpm ls @xyflow/react`
prints `12.12.0` and that `package.json` has no caret.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): Map section with React Flow canvas, custom nodes and honest presence`

---

### Task 4: Edges: animated tunnels, jumps and memberships

**Files:**
- Create: `src/renderer/src/map/edges.tsx`.
- Modify:
  - `src/renderer/src/map/MapCanvas.tsx`: `edgeTypes`, and edge building
    from `graph.edges`;
  - `src/renderer/src/pages/tunnels/RouteLine.tsx`: export
    `FLOW_DURATION`, so the map and the cards share the speed steps;
  - `src/renderer/src/ui/tokens.css`: the `.od-travel` opacity
    keyframes, disabled under reduced motion.
- Test: `tests/renderer/map-edges.test.tsx` (new; imports
  `./flow-stubs`).

**Interfaces:**
- `edges.tsx` exports `edgeTypes = { tunnel: TunnelEdge, jump: JumpEdge, membership: MembershipEdge }`,
  each `memo`'d.
- It also exports `edgeTone(state: TunnelState): 'ok' | 'warn' | 'err' | 'muted'`.
  It is pure: `up` gives `ok`; `connecting` and `retrying` give `warn`;
  `failed` gives `err`; `stopped` gives `muted`.
- `TunnelEdge` reads `useTunnel(id)` for the state and `useTunnelStats(id)`
  for the rates, and nothing else.

**Behaviour:**
- **`TunnelEdge`:**
  - The path is `getBezierPath`. Stroke colour comes from `edgeTone`
    (`--ok`, `--warn`, `--err`, `--muted`).
  - **When `up`:**
    - the stroke is dashed with `od-flow`, and `--od-flow-dur` comes from
      `FLOW_DURATION[flowStep(rateIn + rateOut)]`;
    - the stroke width is `1.5`, `2.25` or `3` by step;
    - when motion is safe, a 4 px dot travels the path via SVG
      `<animateMotion>`, with `dur` matching the flow.
  - **When `connecting` or `retrying`:** amber, dashed, still.
  - **When `failed`:** red, solid, with a small break glyph at the
    midpoint.
  - **When `stopped`:** muted, dotted, at 50% opacity.
  - **Label.** An `EdgeLabelRenderer` chip at the midpoint, with
    `pointer-events: all` and a `nodrag nopan` class, showing:
    - the `TUNNEL_TYPE` chip (`L`, `R` or `SOCKS`, each with its colour);
    - the label;
    - when up, `↓ 1.2 MB/s ↑ 30 KB/s` from `formatRate`;
    - when retrying, `retrying`; when failed, `failed`.
  - The chip is a `button` whose `aria-label` is
    `<label>, <type title>, <state>`. Clicking it calls `onEdgeSelect`.
  - A wider transparent interaction path (`interactionWidth={20}`) makes
    the edge easy to click.
  - **Hover:** the edge glows (drop-shadow in its tone), and the two end
    nodes get a soft ring through a `data-related` attribute set by
    `MapCanvas` from the hovered edge id.
  - The state change transitions the stroke colour over 200 ms (CSS),
    not under reduced motion.
- **`JumpEdge`:**
  - a muted dashed step path, with a small `ShieldCheck` marker at the
    source;
  - when `viaEnvDefault`, the dash is longer and the title says
    `environment default`;
  - it is not animated.
- **`MembershipEdge`:** a thin straight line in the product colour.
  Secondary memberships (`primary: false`) are dotted at 40% opacity.
- **Order:** tunnel and jump edges use `zIndex: 1` so they draw above the
  group frames. Membership edges use `zIndex: 0`.

- [ ] **Step 1: Write the failing tests** (`tests/renderer/map-edges.test.tsx`, using `mockBridge`, `emitBridgeEvent`, and `resetTunnels` in `beforeEach`)
- `edge colour follows state and leaves green the moment a tunnel retries`:
  - emit `tunnel:state` `up`: the edge path has `data-tone="ok"` and the
    class `od-flow`;
  - emit `retrying`: in the same `act`, `data-tone="warn"` and no
    `od-flow`;
  - emit `failed`: `data-tone="err"`, and the break glyph exists.
- `stopped tunnels are muted and still`.
- `throughput sets the flow speed and width`:
  - emit `tunnel:stats` with `rateIn: 2_000_000`;
  - the path style has `--od-flow-dur: 0.45s` and `stroke-width: 3`.
- `the label chip shows type, label and rates`.
- `a stats tick re-renders only its own edge`:
  - two tunnels are up;
  - wrap `TunnelEdge` and `HostNode` render counts via `vi.mock` of
    `map/edges` and `map/nodes` with `importOriginal`, as
    `tunnels-page.test.tsx` does for `RouteLine`;
  - spy on `buildGraph` and `layoutGraph` (`vi.mock` of `map/graph` and
    `map/layout`, wrapping the originals);
  - emit `tunnel:stats` for `t1` only;
  - `t1`'s edge count increases by 1, and `t2`'s edge count, every host
    count and both spy call counts are unchanged.
- `R tunnels flow from host to Mac`: the edge's `source` is the host and
  its `target` is `mac` (from the `data-source` attribute or the props
  spy).
- `jump edges are dashed and not animated`, and
  `secondary membership edges are dotted`.
- `reduced motion stills every edge`:
  - `useMotionSafe` is mocked to false, with tunnels `up` at a high rate;
  - no `.od-flow`, no `.od-pulse`, no `animateMotion`, and the colours are
    unchanged.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-edges.test.tsx`
Expected: FAIL. `edges.tsx` doesn't exist, so there are no tunnel edges.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): animated tunnel edges that follow state and throughput, jump and membership edges`

---

### Task 5: Selection, the detail panel and click actions

**Files:**
- Create: `src/renderer/src/map/DetailPanel.tsx`.
- Modify:
  - `src/renderer/src/pages/map/MapPage.tsx`: selection state, the panel,
    and double-click;
  - `src/renderer/src/map/MapCanvas.tsx`: `onNodeDoubleClick`,
    `onEdgeClick`.
- Test: `tests/renderer/map-panel.test.tsx` (new; imports
  `./flow-stubs`).

**Interfaces:**
- `DetailPanel` props:
  `{ selection: { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null; graph: MapGraph; onClose(); onFilter(scope: MapScope) }`.
- `MapPage` keeps `selection` in state, not in the URL. It is cleared
  when the selected id disappears from `graph`. When a host vanishes,
  focus moves to its environment group if that still exists (Task 8 reads
  this).

**Behaviour:**
- The panel slides in from the right: a 340 px wide `motion.aside` with
  `spring` (an opacity fade only under reduced motion). It has a close
  button, and `Escape` closes it. It does not cover the minimap; the
  minimap shifts left while the panel is open.
- **Host panel**, opened by clicking a host node:
  - a header with the OS icon, the label and the address (mono);
  - role, from `ROLE_LABEL`;
  - the reachability text and session count;
  - environments: chips for every environment the host is in, with
    `this placement` marked;
  - vaults: names only;
  - jump: `via bastion`, plus `environment default` when it applies;
  - tunnels on the host: one row each with the type chip, label, state
    text and a `Switch` that calls `startTunnel` or `stopTunnel`;
  - actions:
    - **Connect** is the primary action. It calls
      `connect(hostId, environmentId)` for this placement and navigates
      to `/terminals`;
    - **Open host page** goes to `/hosts?host=<id>` (the Hosts page reads
      only `host` today; no new param is added);
  - focus moves to **Connect** when the panel opens.
- **Environment panel:**
  - name, protected badge, products and host count;
  - a role breakdown (`Bastion 1 · App 4 · Database 2`);
  - **Filter to this environment** calls `onFilter`;
  - **Open in Products** goes to `/products?node=<environmentKey>`.
- **Product panel:**
  - name, description and environment count;
  - **Filter to this product**;
  - **Open in Products** goes to `/products?node=p:<id>`.
- **Tunnel panel**, opened by clicking a tunnel edge or its label chip:
  - `RouteLine` with the same props the Tunnels page uses;
  - a `Switch` (start/stop, `busy` while connecting);
  - the status text, with the same strings as `TunnelCard`: `Up 12 min`,
    the retrying countdown, or the failed message;
  - **Open in Tunnels** goes to `/tunnels`.
- **This Mac panel:** the tunnel count, and a list of tunnels with
  switches.
- **Double-click on a host** connects at once, using that placement's
  environment. Double-click on a group fits the view to that group
  (`fitView({ nodes: [{ id }], duration })`).
- Clicking the pane clears the selection. The selected node shows the
  accent ring, and a selected edge glows.

- [ ] **Step 1: Write the failing tests** (`tests/renderer/map-panel.test.tsx`)
- `clicking a host opens its panel with focus on Connect`:
  - the `complementary` region named `web` has role `Bastion`, the
    address and vault names;
  - `document.activeElement` is the **Connect** button.
- `the host panel shows no private fields`: the identity username and
  the host notes sentinels are absent from the panel text.
- `Connect opens a session for that placement`:
  - with a shared host clicked in `e2`, `ssh:open` is called with
    `h1, e2`;
  - the route becomes `/terminals`.
- `double-click on a host connects`.
- `the tunnel switch in the host panel starts and stops`: it calls
  `tunnel:start` and then `tunnel:stop`.
- `clicking a tunnel edge opens the tunnel panel with its route and
  switch`.
- `environment panel filters to the environment`: the URL gains
  `?env=e1`.
- `Escape and pane click close the panel`.
- `deleting the selected host closes its panel`:
  - emit an inventory reload without the host;
  - the panel is gone, nothing throws, and the selection is `null`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-panel.test.tsx`
Expected: FAIL. `DetailPanel` doesn't exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): detail panel with connect, tunnel toggles and click actions`

---

### Task 6: Filters, search with zoom-to, viewport memory and drag pins

**Files:**
- Create:
  - `src/renderer/src/map/search.ts`;
  - `src/renderer/src/map/viewport.ts`.
- Modify:
  - `src/renderer/src/pages/map/MapPage.tsx`: the toolbar;
  - `src/renderer/src/map/MapCanvas.tsx`: viewport restore and save,
    drag pins, zoom-to.
- Test:
  - `tests/renderer/map-search.test.ts` (new; pure);
  - `tests/renderer/map-viewport.test.ts` (new; pure);
  - `tests/renderer/map-toolbar.test.tsx` (new; imports
    `./flow-stubs`).

**Interfaces:**
- In `search.ts`:
  - `searchGraph(graph: MapGraph, query: string): { matches: string[]; best: string | null }`;
  - it uses `fuzzyMatch` from `ui/commands.ts` over node labels: product
    and environment names, and host label, address and tags;
  - `best` is the highest score, with ties going to node order;
  - an empty query gives `{ matches: [], best: null }`.
- In `viewport.ts`:
  - `loadViewport(scopeKey): Viewport | null` and
    `saveViewport(scopeKey, vp)`;
  - storage key `opsdeck.map.viewport`, capped at `MAX_VIEWPORTS = 32`
    with the oldest write evicted;
  - every access is in `try/catch`, and a bad JSON value reads as empty.
- `MapCanvas` gains:
  - the props `scopeKey`, `pins` and `onPin(id, pos)`;
  - an imperative `zoomTo(id)`, exposed through a ref.

**Behaviour:**
- **Filters:**
  - two compact selects in the toolbar: **Product** (`All products` plus
    each product) and **Environment** (`All environments` plus the
    environments of the chosen product, or all);
  - changing the product clears an environment that isn't in it;
  - both are stored in the URL (`/map?product=&env=`), so the browser
    back button and palette links work;
  - a **Clear** chip appears when either is set.
- **Search:**
  - a search field (`mod+f` focuses it while on `/map`, through
    `useShortcut`) with the placeholder `Find host, environment…`;
  - typing dims non-matching nodes to 25% opacity, along with their
    edges, and keeps matches' ancestor groups at full opacity;
  - a count shows `3 matches`;
  - **Enter** zooms to `best` with
    `fitView({ nodes: [{ id }], padding: 0.6, maxZoom: 1.25, duration: motionSafe ? 450 : 0 })`,
    selects it and plays a one-shot highlight ring for 1.2 s (static
    under reduced motion);
  - **Enter** again cycles to the next match;
  - **Escape** clears the search;
  - if the best match is outside the current filter (searching an id from
    the full inventory), the filter is cleared first, then the view zooms
    after the layout settles.
- **Viewport:**
  - on mount and on scope change, restore the stored viewport for
    `scopeKey`, or `fitView` when there is none;
  - `onMoveEnd` saves, debounced by 300 ms;
  - a **Fit view** toolbar button (and the `Controls` one) fits all
    nodes.
- **Drag pins:**
  - `onNodeDragStop` records the node's position in the pins for the
    current scope. The pins live in a module-level `Map<scopeKey, pins>`,
    so they survive navigating away and back but not a restart;
  - **Reset layout** appears when pins exist, and clears them with a
    glide (Task 7);
  - group nodes drag with their hosts, as React Flow does by default.
    Hosts are bounded to their group (`extent: 'parent'`).

- [ ] **Step 1: Write the failing tests**

`map-search.test.ts`:
- `matches hosts by label, address and tag`.
- `best prefers the highest score, then node order`.
- `empty query matches nothing`.

`map-viewport.test.ts`:
- `round-trips per scope`.
- `evicts the oldest past 32 scopes`.
- `survives throwing storage`: stub `localStorage.getItem` and `setItem`
  to throw. `load` returns `null` and `save` does not throw.
- `ignores corrupt JSON`.

`map-toolbar.test.tsx`:
- `product filter narrows the graph and the URL`:
  - choosing `Billing` gives `?product=pB`;
  - nodes outside it are gone.
- `environment options follow the product`.
- `search dims non-matches and Enter zooms to the best`:
  - spy on `fitView`: `vi.mock('@xyflow/react')` with `importOriginal`,
    wrapping `useReactFlow` so the returned instance's `fitView` is a
    spy that still calls through;
  - non-matching nodes have `data-dimmed="true"`;
  - after Enter, `fitView` is called with `nodes: [{ id: 'e:e1/h:h1' }]`
    and `duration: 450`;
  - the node is selected.
- `search zoom-to jumps under reduced motion`: `duration: 0`.
- `search outside the filter clears the filter first`.
- `restores the stored viewport for the scope`: seed `localStorage`. The
  viewport transform reflects `{ x, y, zoom }`, read through
  `useReactFlow().getViewport()`.
- `dragging pins a node and Reset layout clears it`:
  - fire React Flow's drag-stop through `onNodeDragStop`, triggered by
    pointer events on the node;
  - if jsdom can't drive the drag, call the exported handler directly. The
    test documents which it does;
  - the pin is used on rebuild, and **Reset layout** removes it.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-search.test.ts tests/renderer/map-viewport.test.ts tests/renderer/map-toolbar.test.tsx`
Expected: FAIL. `search.ts` and `viewport.ts` don't exist, and there is
no toolbar.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): filters, search with zoom-to, per-scope viewport and drag pins`

---

### Task 7: Smooth inventory transitions

**Files:**
- Create: `src/renderer/src/map/useGraphTransition.ts`.
- Modify: `src/renderer/src/map/MapCanvas.tsx`, which feeds React Flow
  the transitioned nodes and edges.
- Test: `tests/renderer/map-transition.test.tsx` (new; fake timers, plus
  a `requestAnimationFrame` shim driven by `vi.advanceTimersByTime`).

**Interfaces:**
- `useGraphTransition(target: { nodes: Node[]; edges: Edge[] }, opts: { motionSafe: boolean; durationMs?: number }): { nodes: Node[]; edges: Edge[] }`.
  - `durationMs` defaults to 300 ms for glides and 180 ms for leaving.
  - Easing is `easeOutCubic`.
- `cancelGlide(id)` is exported for the drag handler.

**Behaviour:**
- On each new target, `diffLayout(prev, next)` from Task 2 decides what
  happens:
  - **moved** nodes tween from their current rendered position to the
    target in `requestAnimationFrame`. A rebuild during a glide starts
    from wherever the node is, with no jump;
  - **entering** nodes appear at their target with `className`
    `od-node-enter` (the CSS fade and scale). Their edges fade in with
    them;
  - **leaving** nodes and their edges stay for 180 ms with
    `data: { …, leaving: true }`, rendered faded and with
    `pointer-events: none`, then they are dropped;
  - groups resize smoothly, because width and height tween with position.
- **Input always wins.** A drag start on a gliding node cancels its glide
  (`cancelGlide`). Clicks are never blocked, because nodes stay
  interactive while gliding (only leaving nodes ignore pointers).
- **Reduced motion:** the output is the target, unchanged and at once.
  There is no `od-node-enter`, no leaving phase and no rAF.
- The first render never animates (no prev), so the map does not "fly
  in" on every navigation.
- Selection and the focused id survive transitions, because ids are
  stable.

- [ ] **Step 1: Write the failing tests** (`tests/renderer/map-transition.test.tsx`)
- `a moved node glides to its new position`:
  - add a host to a group above, which pushes the group below down;
  - at t = 0 the lower group's `transform` is at the old y;
  - at t = 150 ms it is strictly between the old and new y;
  - at t = 300 ms it is exactly the new y.
- `an entering host fades in`: the new node has the class
  `od-node-enter`, and it is removed after the animation.
- `a removed host lingers then leaves`:
  - right after removal the node exists with `data-leaving="true"` and
    `pointer-events: none`;
  - after 180 ms it is gone;
  - its edges go with it.
- `a rebuild mid-glide continues from the current position`.
- `reduced motion skips the glide`: final positions in the same tick,
  no `od-node-enter`, and removed nodes are gone at once.
- `first render does not animate`.
- `the panel stays open while its host glides`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-transition.test.tsx`
Expected: FAIL. `useGraphTransition` doesn't exist, so nodes jump.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): smooth inventory transitions that glide, fade in and fade out`

---

### Task 8: Keyboard navigation, the List view, palette commands, entry points and roadmap

**Files:**
- Create:
  - `src/renderer/src/map/keyboard.ts`;
  - `src/renderer/src/map/MapList.tsx`;
  - `src/renderer/src/map/commands.ts`.
- Modify:
  - `src/renderer/src/pages/map/MapPage.tsx`: the focus model, live
    region and Map | List toggle;
  - `src/renderer/src/map/MapCanvas.tsx`: the wrapper's `tabIndex`, key
    handling and focus ring;
  - `src/renderer/src/shell/AppShell.tsx`: `useMapCommands()`;
  - `src/renderer/src/pages/products/EnvironmentView.tsx` and
    `ProductView.tsx`: a **Show on map** header action;
  - `src/renderer/src/pages/hosts/HostView.tsx`: a **Show on map**
    `RowMenu` item;
  - `docs/superpowers/plans/2026-10-16-roadmap.md`: row 6 status
    `done (branch \`phase6-visualization\`)`.
- Test:
  - `tests/renderer/map-keyboard.test.ts` (new; pure);
  - `tests/renderer/map-a11y.test.tsx` (new; imports `./flow-stubs`);
  - `tests/renderer/map-commands.test.tsx` (new).

**Interfaces:**
- In `keyboard.ts`:
  - `interface FocusModel { order: string[]; parent: Record<string, string | null>; children: Record<string, string[]> }`;
  - `focusModel(graph: MapGraph): FocusModel`;
  - `nextFocus(model, id: string | null, key: string): string | null`.
    It is pure. Its rules:
    - `ArrowRight` goes to the first child. A product's children are its
      primary environments, and a group's children are its hosts. A host
      with tunnels goes to `mac`;
    - `ArrowLeft` goes to the parent. A host goes to its group, and a
      group goes to its primary product;
    - `ArrowDown` and `ArrowUp` go to the next or previous sibling, and
      stop at the ends;
    - `Home` and `End` go to the first or last sibling;
    - `null` plus any arrow goes to the first node.
- `MapList` props: `{ graph: MapGraph; onConnect(hostId, envId); onSelect(id) }`.
- `useMapCommands()` registers the palette commands below while the shell
  is mounted.

**Behaviour:**
- **Keyboard on the canvas:**
  - the canvas wrapper is one tab stop (`tabIndex={0}`) with
    `role="application"`,
    `aria-roledescription="topology map"` and
    `aria-label="Topology map, use arrow keys to move between nodes"`;
  - arrow keys move a *focused* id. That is separate from selection, and
    drawn as a focus ring;
  - the view pans to keep the focused node visible
    (`setCenter` if it is outside the viewport, with duration 0 under
    reduced motion);
  - `Enter` or `Space` opens the panel (selects). `Enter` on a host with
    the panel open connects;
  - `Escape` closes the panel, and a second `Escape` clears the focus;
  - `/` focuses search;
  - `+`, `-` and `0` zoom in, zoom out and fit view;
  - when the focused node disappears, focus moves to its parent if it
    still exists, otherwise to the first node.
- **Live region:** a visually hidden `aria-live="polite"` element
  announces the focused node, for example
  `web, Bastion in prod, Reachable, 1 session, 2 tunnels`, or
  `prod environment, 5 hosts`. The text is built from the same node data.
- **Map | List toggle** (`?view=list`), a segmented control in the
  toolbar:
  - `MapList` is a `table` with the caption `Hosts by environment` and
    one `rowgroup` per environment (with its name as a header row);
  - columns: Host, Address, Role, Reachability (text), Sessions, Tunnels
    (each with label, state text and a `Switch`), and Actions
    (**Connect**, **Show on map**);
  - the same filter and search apply. Matches are not dimmed in the list;
    non-matches are hidden instead;
  - **Show on map** switches to the map and zooms to the node.
- **Palette commands** (section `Map`):
  - `Open map`, with the shortcut shown as `mod+6`;
  - `Find on map`, which navigates to `/map` and focuses search;
  - `Show <env> on map` for each environment, which navigates to
    `/map?env=<id>`;
  - `Show <host> on map` for each host, which navigates to
    `/map?focus=<hostId>` (the same entry point as `HostView` below);
  - `Reset map layout`.
  - The commands re-register when the inventory changes, like
    `useInventoryCommands`.
- **Entry points:**
  - `EnvironmentView` header: a ghost **Show on map** button (`Network`
    icon) that goes to `/map?env=<id>`;
  - `ProductView` header: `/map?product=<id>`;
  - `HostView` `RowMenu`: **Show on map**, which goes to
    `/map?focus=<hostId>`. `MapPage` reads `focus` once, zooms to the first
    placement, selects it, then removes the param.
- **Roadmap:** set row 6's status to `done (branch \`phase6-visualization\`)`.

- [ ] **Step 1: Write the failing tests**

`map-keyboard.test.ts`:
- `arrow keys walk the hierarchy`:
  - from `null`, `ArrowDown` gives `p:p1`;
  - `ArrowRight` gives `e:e1`;
  - `ArrowRight` gives `e:e1/h:h1`;
  - `ArrowDown` gives `e:e1/h:h2`;
  - `ArrowLeft` gives `e:e1`;
  - `ArrowLeft` gives `p:p1`.
- `stops at sibling ends; Home and End jump`.
- `a host with tunnels goes right to this Mac`.

`map-a11y.test.tsx`:
- `the canvas is one tab stop with an application role`.
- `arrow keys move focus and announce it`:
  - `keyDown` `ArrowDown` on the wrapper;
  - the live region reads `Platform product, 2 environments`;
  - the node has `data-focused="true"`.
- `Enter opens the panel for the focused node`.
- `focus follows a deleted host to its group`.
- `list view mirrors the map`:
  - `?view=list` renders a `table`;
  - every host placement is a row with the same reachability text as its
    node;
  - `Connect` calls `ssh:open`, and a tunnel `Switch` calls
    `tunnel:start`.
- `list view honours the filter and search`.

`map-commands.test.tsx`:
- `registers Map commands while mounted`: `Open map`, `Find on map`,
  `Show prod on map` and `Show web on map`. They are gone after
  unmount.
- `Show prod on map navigates with the env filter`.
- `Show on map from EnvironmentView and HostView navigates and focuses`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/map-keyboard.test.ts tests/renderer/map-a11y.test.tsx tests/renderer/map-commands.test.tsx`
Expected: FAIL. `keyboard.ts`, `MapList` and `commands.ts` don't exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(map): keyboard navigation, list view, palette commands and Show on map; roadmap row 6 done`

---

## Self-review notes

- **Spec coverage:**
  - G13 (topology map, tunnels as animated flowing edges in status
    colours, smooth transitions) is covered by T1–T4 and T7.
  - G1a (the map browses Product → Environment → Host) is covered by T1,
    T2 and T8 (keyboard walks the same hierarchy).
  - §8.5:
    - a map view per environment: the environment scope (T1, T6), plus
      an all and a product view beyond that;
    - hosts as nodes with a role icon and reachability dot (T3);
    - tunnels as dashed edges flowing in the direction of traffic (T1
      direction, T4 animation);
    - green up, amber retrying, red failed (T4);
    - reduce motion (T4, T6, T7, pinned in Review Focus 4);
    - apps attached to their host: the seam only, through `attachments`
      and `ATTACH_H` (Phase 8).
  - §5 anti-goals:
    - never up while dead: presence and edge colour read live runtime,
      and there is no inferred green (Review Focus 1);
    - animation never blocks input (T7 `Input always wins`, and rAF-only
      tweens).
  - §6 React Flow and Framer Motion: T3 and T5.
  - §7 jump resolution: T1.
  - §8.1 visible while locked: T3 `renders while the vault is locked`.
  - §10 feel:
    - springs on the panel;
    - ⌘K commands (T8);
    - dark-first `--xy-*` theme (T3).
- **Constraints from the brief:**
  - Every security constraint is kept: no IPC, no new data in the DOM
    (T1 and T5 private-field tests), and CSP unchanged.
  - Renderer only: the File map has no `src/main` or `src/shared`
    changes. Any IPC need is a stop-and-raise (Global Constraints).
  - The dependency is pinned exactly, at an existing version at least two
    weeks old (T3 step 3 checks it).
  - The layout choice is justified in Tech Stack.
  - Interaction:
    - animated edges (T4);
    - node click to detail or connect (T5);
    - edge click to toggle or open (T5);
    - filters (T6);
    - search with zoom-to (T6);
    - transitions (T7);
    - minimap and fit view (T3, T6);
    - viewport persistence (T6). Positions are deliberately not
      persisted, with the reason in Global Constraints.
  - Polish: hover lift and glow, the travelling dot, throughput-scaled
    dashes, enter and leave fades, and the highlight ring. All are
    disabled under reduced motion.
  - Performance at 200 hosts: T2's timing and overlap test, `memo`'d
    nodes, per-id store subscriptions (Review Focus 2), and
    `onlyRenderVisibleElements` past 120 nodes.
  - Accessibility: one tab stop with arrow navigation, a live region,
    and a List table alternative (T8).
  - Tests run in jsdom. The `ResizeObserver`, `DOMMatrixReadOnly`,
    `offsetWidth`/`offsetHeight` and `getBBox` stubs are specified in
    Global Constraints and live in `flow-stubs.ts`. Pure logic lives in
    `graph.ts`, `layout.ts`, `presence.ts`, `search.ts`, `viewport.ts`
    and `keyboard.ts`, each with its own DOM-free test file.
- **Types:**
  - `MapScope`, `MapNode`, `MapEdge`, `MapGraph` and the node and edge
    data types are defined in T1 and used unchanged in T2–T8.
  - `MapLayout`, `Placed`, `diffLayout` and the constants are defined in
    T2 and used by T3, T6 and T7.
  - `Reach`, `REACH_TEXT` and `hostPresence` are defined in T3 and used by
    T5 and T8.
  - `edgeTone` is defined in T4.
  - `FLOW_DURATION` becomes an export of `RouteLine.tsx` in T4, with no
    behaviour change.
- **Risks the implementer should know:**
  - React Flow in jsdom renders nodes only after the `ResizeObserver`
    stub reports a non-zero wrapper size. If nodes don't appear, check
    the stub first.
  - Driving a real drag through jsdom pointer events may not work. T6
    lets the test call the handler directly, and says so.
  - Inserting Map moves Deployments to `mod+7` and Audit to `mod+8`.
    `shell.test.tsx` and `terminals-page.test.tsx` are updated in T3.
    Find anything else that asserts these shortcuts with
    `grep -rn "mod+[678]" tests src`.
- **Deferred:**
  - app and deployment nodes and the pipeline animation (Phase 8, through
    `MapNodeKind`, `attachments` and `ATTACH_H`);
  - container nodes (Phase 7);
  - reachability probing without a session or tunnel (would need IPC);
  - persisting dragged positions across restarts;
  - exporting the map as an image.
