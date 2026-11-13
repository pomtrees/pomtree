# Budget as a coordination signal: design

This document decides what model budget *means* in a pomtree swarm, how it may move, and who may move it, and takes each choice to its logical extreme to see where it stops. The mechanics of running out of budget and asking for more are in section 13. Stages 1 and 2 are written against a domain example, a specialist research-board extension that is not part of this repository, whose concepts appear below only as illustration. Section 11 states which parts exist in code and which are design only.

Numbers in brackets refer to Sources. Claims that rest on the author's reasoning, not on a cited source or on the code, are marked as such in the text.

Evidence labels: `[verified]` means checked against the code or a cited source (`[verified: file/symbol]` names what was checked), `[inferred]` means reasoned from verified facts, and `[knowledge-only]` means drawn from general knowledge without a source checked for this page.

The domain example uses three terms. A **thread** is one unit of research work, a **desk** is the deterministic coordinator that funds threads each round, and a **board** is the shared record of a thread's posts and results. Terms below repeats them.

## 1. Summary and decisions

Budget in pomtree is the operator's money, measured in micro-dollars of provider spend, lent to agents for the length of a task. This design makes two commitments and draws one boundary. The commitments: money is conserved (only a journaled operator top-up or withdrawal changes the pool), and agents hold allowances, never wealth. The boundary: deciding who gets the next dollar is the job of deterministic coordinators running a stated policy, not of a market among agents. That policy stays an equal share per thread until a bandit over thread value measurably beats it, and later adds proper scoring of agents' stated forecasts. Every richer mechanism examined in section 6 (staking, voting, quadratic funding, an internal prediction market, agoric resource markets) either creates money, rewards the wrong behavior, or assumes independent participants that copies of one model are not.

Table 1 is the decision register. E-numbers are decision ids; they appear in section headings and in section 12.

| Decision | What it means | Section |
| --- | --- | --- |
| Conserved, pegged ledger (E1) | One double-entry ledger in micro-dollars, 1:1 with metered provider spend; only operator top-ups and withdrawals change the pool, and a withdrawal takes at most the unheld remainder | 3 |
| Allowances, not wealth (E2) | An agent may spend its carve on its own model calls; it cannot transfer, save, or earn budget | 4 |
| Policy, not market (E3) | Deterministic coordinators reallocate by a versioned policy | 5.1 |
| Equal share until a bandit wins (E4) | Stage 1 keeps the equal per-thread share; a Thompson-sampling bandit, seeded from `asOf` and a board hash, replaces it only after a measured gain | 5.2 |
| Proper scoring (E5) | Stage 2: Brier scores on stated probabilities, resolved against forward paper P&L over a versioned horizon and a policy-fixed benchmark, post-training-cutoff only | 5.3 |
| Calibrated cost carves (E6) | A validation's carve comes from the role's bias-corrected estimate, not the raw declared cost | 5.4 |
| Plan-only outcome marks (E7) | In a domain example, paper P&L is an offline mark of an order ticket; no order is ever placed | 5.5 |
| Rejected mechanisms (E8) | Stake or vote with budget, quadratic funding, an internal LMSR market, agoric and bucket-brigade designs | 6 |
| Vocabulary (E9) | Credential issuance is "issue", money injection is "top-up", and no word implies agents hold wealth | 10 |

*Table 1. Decision register. Reopen triggers are in section 12, and each rejection in section 6 names its own.*

### Terms

- **Micros**: millionths of a dollar, the only unit of budget.
- **Metered spend**: what the model proxy settles for a call (provider-reported cost, else a catalog price, else the full reservation), as set by the model proxy's settlement rules (section 3.1). It is the proxy's record of what the provider will bill, not the invoice itself.
- **Top-up, withdrawal**: the operator adding money to the root pool (journaled as `budget_topup`) or taking unheld money out of it (journaled as `budget_withdrawal`; the held amount includes the root's settled spend). Together they are the operator's **injections**, a signed total.
- **Carve**: the budget a parent sets aside for a child at spawn. **Refund**: the unused part of a carve returning to the parent on reap. **Grant**: an ancestor raising a descendant's budget through a `budget_raise` approval (section 13). **Write-off**: a parent absorbing a child's spend beyond its carve, journaled as `budget_overage`.
- **Allowance**: the right to spend a carve on one's own model calls within one task.
- **Coordinator**: an agent that spawns, budgets and reaps others. A **deterministic coordinator** is code with no model, such as a domain example's desk and thread coordinators, which spend nothing themselves.
- **Thread, round, desk, board**: in a domain example, the unit of work, the unit of scheduled activity, the coordinator that funds threads each round, and the shared record of posts and results that the desk reads.
- **Proper scoring rule**: a score for a probabilistic forecast whose expected value is best when the forecaster reports its true belief [2].
- **Paper P&L**: in a domain example, the profit or loss an order ticket would have made had it been filled, computed from price bars after the fact.

## 2. The question

A swarm needs some signal that decides which work proceeds. Pomtree already has one, by construction: every model call costs money, every agent has a budget carved from its parent's, and an agent that runs out parks until an ancestor or the operator grants more (SPEC.md, "Authority and approval"). Budget therefore already coordinates. The question is how far to push that: whether budget should become a currency agents earn, trade and stake, a price that discovers the value of work, or stay what it is now, a scarce allowance handed down a tree.

Two facts about the participants shape the answer. First, agents have no preferences over money. A model does not want a larger balance; it follows its prompt. Mechanisms designed for self-interested humans (staking, markets, quadratic funding) work by aligning what a participant wants with what the system wants, and an agent has no wants to align. What survives that observation is the measurement side of those mechanisms: a proper scoring rule is still the right way to *grade* a forecast, whether or not the forecaster cares about the grade. Second, the participants are not independent. A swarm runs many copies of a few models with similar prompts, so their errors are correlated and, as section 6 argues, they can coordinate without being told to [4]. Any mechanism whose guarantees rest on many independent participants loses them.

The design below follows from treating budget as the operator's money on loan (sections 3 and 4) and treating allocation as the operator's policy, executed by code (section 5).

## 3. Money: a conserved, pegged ledger (E1)

### 3.1 The peg

Budget is denominated in micros of metered provider spend, one to one. There is no internal credit, no exchange rate, and no second unit. The argument is about what the operator's dial means. The operator sets the root pool in dollars because dollars are what the provider bills. If any internal unit floated against dollars (credits that inflate when agents are rewarded, points convertible at a policy rate), the operator's setting would stop bounding the bill, and every decision taken in the internal unit would need converting back to find its real cost. A peg keeps one fact in one place: the bill.

The peg is to metered spend, not to the provider's invoice. The two can drift wherever the meter is wrong: a stream cut mid-body, a model with no price, an unmetered adopted agent, a call that fails before any response headers. Known gap: those cases are meter inaccuracies. A cut stream is charged from reported usage, else bytes received, else its full reservation; a model with no price is charged its per-request maximum; an agent re-adopted after a daemon restart is bounded by the proxy's cap but has no daemon-side budget check. A call whose fetch rejects or aborts before the response headers is charged nothing and its reservation is released, though the provider may still have billed it; the daemon journals an error record for it naming the cause and the released micro-USD, so the operator can reconcile. Fixing a gap tightens the peg without changing this design. Reconciling metered spend against invoices is an operator task outside the system (no provider invoice API is assumed).

### 3.2 Conservation

Money crosses the system's boundary in exactly three ways. It enters only by an explicit operator top-up of the root pool. It leaves by metered provider spend, or by an operator withdrawal from the root pool. Both operator movements are journaled with their before and after values. Every other movement is a transfer between two accounts inside the system that changes no total:

| Movement | From | To | Journaled as |
| --- | --- | --- | --- |
| Top-up | operator (outside) | root | `budget_topup` |
| Withdrawal | root (unheld remainder only) | operator (outside) | `budget_withdrawal` |
| Carve | parent | child | spawn |
| Reservation | agent | in-flight escrow | proxy reserve |
| Settle | escrow | provider spend (outside) | proxy settle |
| Cancel | escrow | agent | proxy cancel |
| Refund | reaped child | parent | reap |
| Grant | granting ancestor | descendant | `budget_granted` |
| Write-off | parent | child's deficit | `budget_overage` |

*Table 2. Every way budget moves. Only "top-up" adds money; only "withdrawal" and "settle" remove it.*

Each row is one double-entry posting: a debit and a credit of equal size, so the sum over all accounts never changes. The invariant follows directly:

> **Σ balances + Σ metered provider spend = Σ top-ups − Σ withdrawals**

where a balance counts what an agent can still spend plus its in-flight escrow, and the root's balance is signed (it may go negative, see below). The core ledger (`budget-ledger.ts`) states the same identity in snapshot form: the root's signed remaining, plus each live non-root agent's remaining floored at zero, plus every agent's own use (settled spend and in-flight reservations), equals the root pool (the module's header comment). The two are the same statement. A live child whose subtree overran its carve shows zero remaining because its parent already holds the larger of carve and consumption against it, so the overrun is counted once, on the parent.

Overage is where conservation is tested. A provider can bill more than the reservation for a call; the proxy then settles the true charge, the agent's balance goes negative, and the money is already gone. Conservation does not prevent that, and no ledger can, because the provider spent it. What conservation does is make sure it is *booked*: the deficit is written off against the parent, the parent's against its parent, and in the worst case the root's balance goes negative. A negative root is the honest record that the system spent more than the operator injected. It admits no further reservation (fail closed, SPEC rule 8) and is cured only by a top-up. Without the hierarchical ledger, an overage beyond a carve would vanish from the tree's accounts, which is exactly the failure a conservation invariant exists to expose.

A withdrawal is the operator lowering `budget.rootMicros`. It takes at most the root's unheld remainder, meaning the pool minus everything carved to live agents and the root's own in-flight use, and it refuses only the part that is already carved. A request for more is refused in full with the amount available, never clipped silently, so the journaled figure is always what the operator asked for. Lowering the pool is therefore never a way to claw back a running agent's allowance; that is what `pomtree cancel` and the reap refund are for.

### 3.3 Where the invariant is checked

The invariant is enforced in one place and audited in two. Enforcement is the durable debit store's reserve transaction: a reservation is admitted only if it fits every ancestor's remaining (`ledgerFits` over the ledger view), in the same transaction that writes it, so no interleaving of reservations can overspend a subtree.

The ancestor walk must fail closed. A walk that cannot reach the root, whether from a missing node, a cycle or a depth limit, refuses the reservation; it never admits it. `ledgerFits` enforces this: a missing node or parent, a parent cycle, or a chain deeper than `LEDGER_MAX_DEPTH` (1024) refuses the reservation, with a reason naming the cause and the repair (`packages/core/src/budget-ledger.ts`). The rule binds every later walk over the tree.

Known gap: neither audit is built; both are designed here. The first audit is a property test in `core` over random sequences of the Table 2 movements, asserting the identity after every step; this is cheap and catches arithmetic regressions. The second is a replay check, run at startup and from `pomtree doctor`, which recomputes the identity from the journal and compares it with the store. Reservations are not journaled: they are rows in the debit store's request table, while each settlement is journaled as `ext.pomtreed.model_settlement` (`store-sqlite/src/store.ts` and `core/src/kinds.ts`). The replay therefore compares settled totals, rebuilding each agent's settled spend and the tree's balances from top-ups, withdrawals, carves, refunds, grants, write-offs and settlements, and leaves in-flight escrow to the store, where it is bounded by the reservation sweep. A mismatch blocks new reservations, and both the block and the operator's acknowledgement are journal rows, the block naming the first journal position at which replay and store diverge. A ledger that cannot be reconciled cannot be trusted to fail closed, and keeping both facts in the journal means a later replay sees the same history.

One alternative would keep an explicit postings table, one row per Table 2 entry, as accounting systems do. It adds a second record of facts the journal and the debit store already hold, so this design keeps the snapshot ledger as the enforcement point and the journal as the postings. Reopen if the replay check finds drift that the journal cannot localize.

## 4. Allowances, not wealth (E2)

An agent's budget is an allowance: the right to spend its carve on its own model calls within one task. It cannot be transferred to a peer, saved past reap, borrowed against, or earned. The only movements open to it are down the tree (a parent carves for a child, an ancestor grants to a descendant through an approval) and back up (the unused carve returns on reap). This is how HPC centers treat allocations: in Slurm, fair-share priority is computed over an account hierarchy whose shares the administrators assign, and a user's standing is a function of usage against those shares, not a balance users can pass to one another, per the hierarchy and sibling ordering the Slurm pages document [1]; the administrative assignment and decay details are from general knowledge.

The argument against wealth is that every property of wealth is an attack surface in a swarm of correlated copies. Transferability lets agents pool budget sideways, so a group of copies can fund what no ancestor approved, which is collusion with no signal of it in the tree. Saving lets an agent hoard against future tasks, so budget accrues to whoever spent least rather than to whoever did the most useful work. Earning requires a payer: either the operator (a top-up disguised as a reward, so the operator's bill depends on agents' success at earning) or other agents (a transfer, so the above). And none of it buys anything, because the agent has no use for wealth beyond the task in front of it. Wealth would add attack surface and accounting with no incentive gained.

An allowance keeps what is useful about budget as a signal. Exhaustion is still a decision point: an agent that runs out escalates, and an ancestor with a view of the wider work decides whether the extra spend is worth it (section 13). A grant from a model ancestor is a subdivision of that ancestor's own allowance, paid from its own remaining, so it moves money only downward and only within a subtree that already held it.

## 5. Reallocation is policy (E3 to E7)

### 5.1 Why policy and not a market

If agents may not trade budget, something else must decide which thread, role or hypothesis gets the next carve. The candidates are a market among agents, a vote among agents, or a policy run by a coordinator. Section 6 takes the first two apart. The case for the third is that the allocation problem in this system is not one markets solve well. A market's virtue is aggregating private information held by self-interested participants. Here the participants hold no private information the coordinator cannot read (every post is on the board), have no self-interest, and are not independent. What the allocator lacks is not information about what agents want but information about *what work turns out to be valuable*, and that is an explore-and-exploit problem with delayed, noisy feedback. Bandit algorithms are built for that problem, and proper scoring rules are built for grading the forecasts that feed it.

The coordinators that run the policy are deterministic: code, versioned, with no model of their own. This keeps SPEC design rule 9 (policy lives in one place) and a domain example's rule that model output is untrusted and changes durable state only through deterministic validation. A model can still draft a rationale or propose a hypothesis; it cannot set its own funding.

### 5.2 Stage 1: equal share until a bandit wins (E4)

Design for an extension that is not in this repository.

The desk gives every thread with pending work an equal share of the round's budget, capped by the per-round thread maximum and the thread's remaining lifetime budget, so that thread ids do not decide who is funded (the equal-share rule of a domain example's desk coordinator). The lifetime budget is fixed at opening, scaled only by an intake verdict. Equal share spends the same on a thread producing evidence every round as on one producing nothing, but it is simple, explainable and has no tuning to get wrong. It therefore stays the policy until a measured comparison on the same boards shows a bandit doing better (section 11, Stage 1). The candidate is a multi-armed bandit: an allocator that repeatedly chooses among options ("arms") of unknown value, learning from each choice's result. Here the arms are the open threads.

The reward is the thread's deterministic value events per micro spent. A value event is a change the board reducer records on a deterministic basis: a load-bearing finding reaching `reproduced`, a hypothesis decided `validated` *or* `refuted` by the runner or a recomputation stamp, a promotion that passes the promotion rule, and the user's approval of the example's final recommendation at `pomtree decide`, each with a policy weight. Refutations count as much as validations. A reward on validation alone would push the allocator toward threads that confirm things, which is the confirmation bias the hypothesis lifecycle exists to resist; a refutation is information, and the trial ledger already makes the next hypothesis on the same asset harder to pass. Equal weights carried a known risk: a thread could farm refutations by proposing hypotheses that are trivially false. For document tests the risk is moot: a recomputed document test is never recorded refuted (it is inconclusive), so it earns no refutation reward, and `triviallyFalse` cannot fire on real boards. Only runner-decided refutations can count. The comparison run still measures the share of refuted hypotheses that a fixed check marks trivially false; if that share is material, one of two guards applies, a per-thread cap on rewarded refutations per round or a minimum declared test cost for a refutation to count. User approval of that recommendation keeps the highest weight, since it is the one event no agent can produce.

Value events are counts and spend is exposure, so the natural model is a Poisson rate per thread with a Gamma prior: after a round with spend *s* and weighted events *k*, the posterior moves from Gamma(α, β) to Gamma(α + k, β + s) (the conjugate update is standard; Russo et al. cover the Thompson-sampling method in general [8]). Thompson sampling acts on a random draw from each arm's posterior rather than on its mean: each round the desk samples a rate for every thread, ranks threads by the sample, and fills carves in rank order under the existing caps (the per-round thread maximum, the thread's remaining lifetime budget, the child floor). Thompson sampling explores in proportion to the allocator's uncertainty, so a new thread gets funded while its posterior is wide and a thread that keeps producing nothing loses funding at a rate set by the evidence rather than by a hand-tuned cutoff [8].

Three adjustments fit this system. Threads are short-lived arms, so cold start dominates: a new thread's prior is pooled from closed threads of the same class and intake verdict rather than set flat, which is shrinkage toward a group mean (section 9). Value drifts as a thread matures, so posteriors decay by a policy half-life each round, the same device as Slurm's usage decay [1] (the half-life parameter; general knowledge). And the desk must be replayable, which constrains the seed.

The desk's wake keys derive from `asOf` and each thread's `postCount` (a domain example's `wakeKey`), not from the run id. A draw seeded from the run id would give a re-run under a new id different carves under the same keys, and the store would refuse them with 409 `idempotency_conflict`. The draw is therefore seeded from `asOf` and a hash of the board as read, so the same board always draws the same carves. Arm state is not stored either: each round rebuilds every posterior from the board's own records (posts, round summaries with spend), so the desk keeps no state outside the stores and a crash loses nothing (SPEC design rules 4 and 6).

The alternative is UCB (upper confidence bound), which ranks by an optimistic bound instead of a sample and needs no randomness at all. It is the better choice if the operator wants allocations explainable as a single number per thread. Thompson sampling remains the candidate because it handles the pooled, decaying priors more naturally and its exploration needs no tuning constant; both are deterministic given their inputs.

### 5.3 Stage 2: proper scores on stated probabilities (E5)

Design for an extension that is not in this repository.

Stage 1 learns which threads produce evidence. It cannot tell a role that is right from a role that is busy, because value events reward activity that passes deterministic checks, not foresight. Stage 2 adds the missing signal: agents attach a probability to a falsifiable forecast, the forecast resolves against market prices at a fixed horizon, and each forecast earns a proper score.

In a domain example, a forecast is an optional part of a `hypothesis` post that names a tradeable direction on a symbol (section 8.2); a hypothesis with no symbol carries none. It states the probability that the direction beats the benchmark, net of the policy's per-trade cost, from the first close after the post to the close a fixed number of bars later. The benchmark is fixed per asset class in the policy and never chosen by the author, so no forecaster can pick an easy comparator. The horizon, 20 bars by default, is a versioned policy value rather than a constant, because whether a sign over 20 bars carries enough signal is what Stage 2a measures. The event is binary so that the two standard proper rules apply directly. The Brier score, the squared error between probability and outcome, is bounded; the log score, the log of the probability given to what happened, is unbounded and punishes a confident miss without limit [2] (both are proper; their relative robustness is general knowledge). The allocation uses Brier, and the decisive reason is consistency: the skill measure in section 9 is the Brier skill score, and grading with one rule while comparing skill under another would make the two disagree. Brier's boundedness, so that one confident miss cannot erase a role's record, is a second reason. The log score is recorded beside it for diagnosis, with probabilities clipped to a policy range. Both are proper, so a forecaster that reports its actual belief does best in expectation. For a model that does not care about its score, properness still matters: it makes the score a measurement of calibration and discrimination rather than of how cleverly a forecast hedged [2].

Resolution counts only outcomes the model could not have seen. ForecastBench was built on this point: it asks only about events unresolved at forecast time, because a model scored on events inside its training data can recall rather than forecast [5] [verified]. On such a board the forward window always starts after the post, so a live round satisfies the rule automatically, but the board can also run point-in-time replays with an `asOf` in the past, and a replay's "future" may sit inside the model's training data. A forecast is therefore eligible only if its forward window starts after both its post time and the authoring model's training cutoff. The cutoff belongs to the model, not to the template: it is a field of the model id's entry in the model catalog, so two templates on one model cannot disagree about it, and an unknown cutoff makes every forecast from that model ineligible (fail closed). A replay whose agents have web access is ineligible whatever the cutoff, because a fetched page can report the outcome the forecast is about. Ineligible forecasts are still recorded and resolved, for diagnosis, but never scored into allocation.

Scores feed allocation in one place: a thread's Stage 1 prior mean is scaled by the skill of the roles subscribed to it, through shrinkage and a minimum sample (section 9). They deliberately do not reorder hypotheses inside a thread. Funding the hypotheses most likely to validate would reintroduce the confirmation bias the reward in section 5.2 avoids, and the existing cheapest-first order (section 5.4) already spends a thread's budget where it buys the most trials. Scores never become an agent's budget; they inform the policy that sets carves (section 4), and they are shown to the operator for template tuning, as a domain example's role track record already is.

### 5.4 Declared costs (E6)

Design for an extension that is not in this repository.

In a domain example, hypotheses already carry a declared validation cost, and the desk ranks them by that cost scaled by the author role's estimate error (`costFactor`): exp of the root-mean-square log ratio of actual to declared spend. The factor is symmetric in log space. Squared log error is a consistent scoring function for the expected log cost (Gneiting's point-forecast results, not in Sources; general knowledge), so the factor is a sound grade of estimates.

What remains is an incentive leak on the carve side. A validation's carve is the declared cost times the overrun factor (`validationCarve`), so an inflated estimate buys a larger carve and pays for it only later, in rank. The carve is sized from the role's bias-corrected estimate (`validationCarve`, `costBias`), the declared cost times exp of the role's mean log ratio, and rank keeps the root-mean-square factor. Then neither direction of misstatement buys budget. This is kept apart from Stage 2 because it needs no forecasts.

### 5.5 Paper P&L stays plan-only (E7)

Design for an extension that is not in this repository.

A domain example's workflows never place, stage or transmit an order, and design no brokerage or broker-side paper trading; this boundary is fixed. Forward paper P&L does not touch that boundary. It is a pure computation: take the forecast's direction and symbol with the policy's benchmark and window, read bars from the example's `PriceSource`, and compute the excess return net of the policy cost. No order exists, no venue is contacted, and no credential is needed. If a future change wanted fills from a broker's paper account instead, that would cross this boundary and is out of scope for this design.

## 6. Rejected designs (E8)

Each rejection names the failure mode that rules it out here and the trigger that would reopen it.

**Agents stake budget, or vote with it.** Staking asks an agent to put budget at risk on its claim and win budget if right; voting lets agents weight proposals with budget. Both assume independent participants with something to lose. Copies of one model are sybil-equivalent (a sybil is one participant posing as many): ten copies are one opinion with ten votes, and spawning more copies is free to whoever controls the prompt. They also coordinate without instruction: LLM pricing agents in repeated oligopoly reached supracompetitive prices on their own, and small prompt changes moved how far [4] (abstract). Staking adds a second failure that survives even independent agents: when budget at risk is the agent's ability to keep working, the safe strategy is to stake only on near-certain claims, which rewards timidity over accuracy. A domain example likewise declines to gate posting on a role's track record for the same reason. Reopen if a measured Stage 1 baseline plateaus *and* distinct model families with measured low error correlation are available.

**Quadratic funding.** A project receives the square of the sum of the square roots of its contributions, topped up from a matching pool [3]. The matching pool is outside money, which here would be a top-up the operator no longer sizes directly. And the mechanism's appeal comes from rewarding breadth of support, which is exactly what splitting into many identical contributors manufactures; the authors themselves present variants against collusion [3] (the abstract says variants help protect against collusion; the size of the sybil gain is general knowledge). A swarm of copies is the worst case for it. Reopen if contributors become distinct, verified principals, for example several humans funding shared research.

**An internal LMSR market.** Hanson's logarithmic market scoring rule (LMSR) runs a prediction market as a scoring rule applied in sequence, each trader paying off the previous one's forecast [6] (abstract), and its market maker loses at most a bounded subsidy (the bound of *b* ln *n* for *n* outcomes; general knowledge). If traders' winnings are spendable budget, the subsidy is new money paid to agents: money creation by another name, breaking conservation (section 3). If winnings are not spendable, the market is a proper scoring rule with a trading interface, and Stage 2 already scores forecasts directly without the thin-market and sybil problems of a market among copies. Reopen if many agents must forecast combinations of events on which independent scoring is shown to aggregate badly, with winnings kept unspendable.

**Agoric, bucket-brigade and Hayek-machine designs.** Agoric systems let software objects buy and sell computational resources so that allocation emerges from local prices [7] (abstract). Holland's bucket brigade and Baum's Hayek machine pass payment back along chains of agents that contributed to a reward. Chains of payment are where parasites live: an intermediary that adds nothing but sits on the path collects a share, and the literature on these systems spent much of its effort on rules to stop that. A coordinator tree is such a chain, and a model coordinator that could charge its children for being spawned would be a parasite by construction. Notably, the Hayek machine's own remedy was strict conservation of money and property rights, which section 3 already adopts without the market. Beyond parasites, the resource here is one fungible pool whose scheduling is easy; the hard part is valuing outcomes, and a market among agents has no better oracle for that than the coordinator does. Reopen if the system comes to schedule several heterogeneous scarce resources (GPU hours, browser slots, provider rate limits) where prices would beat a scheduler.

## 7. Distance to the extremes

The positions above can be read as choosing a point on several axes, each of which has an extreme some prior design adopted. Table 3 shows where this design stops and why, so a later change can see how far it moves.

| Axis | The extreme | Where this design stands | Distance and reason | What would move it |
| --- | --- | --- | --- | --- |
| Conservation | Every micro is a pegged double-entry posting; only the operator injects | At the extreme | None: anything less leaves the bill unbounded | Nothing; this is the floor |
| Stake to explore | Proposing work costs the proposer budget it loses if wrong | No stake. Brakes are structural: open-hypothesis caps, validation paid from thread budget, every run a trial, checked costs | Far: staking rewards timidity, and copies make stakes sybil-cheap | Section 6, first trigger |
| Market feedback | Prices set by agents' trades decide allocation | Feedback without trade: proper scores and, once it measurably beats equal share, bandit posteriors, all computed by the desk | Far on mechanism, close on signal: the information a market would price is measured directly | Section 6, LMSR and agoric triggers |
| Budget as the coordination signal | Budget is the only thing that decides who runs | Budget decides *how much*; structural rules decide *whether*: intake clearance, independence, evidence states and the promotion rule cannot be bought | Middle: budget allocates, it never certifies | None planned; buying past a gate would make money a source of policy |
| Transferability | Agents hold and trade wealth | Allowances only; movement only down the tree and back on reap | At the opposite extreme | A verified-distinct principal per agent |

*Table 3. Distance to each extreme. "Far" is a deliberate choice backed by section 6, not a gap.*

The fourth row is the one most likely to be pushed later, because it is tempting to let a well-funded thread buy a faster path to promotion. The design's answer is that budget may change how quickly evidence is gathered, never what counts as evidence.

## 8. Data model and port sketches

Design for an extension that is not in this repository.

Stage 1 and Stage 2 need a handful of shapes beyond the ledger. Following SPEC's rule that a port exists only where a second implementation is plausible, none of them is a new core port: the bandit and scoring are pure modules in a domain example, and the resolution oracle is a pure function over its already-pluggable `PriceSource`. Names and module homes below are proposals; each type gets one owning module, as the domain example's design requires.

### 8.1 Policy

```ts
/** Versioned like ResearchPolicy; every score and allocation row records the version it was computed under. */
export interface EconomyPolicy {
  version: string;
  /** Stage 1 */
  eventWeights: Record<ValueEventKind, number>; // e.g. reproduced, validated, refuted, promoted, approved
  priorStrength: number;           // pseudo-observations behind a pooled prior
  halfLifeRounds: number;          // posterior decay
  exploreFloorMicros: Micros;      // every open thread gets at least this per round while its lifetime budget lasts
  /** Stage 2 */
  horizonBars: number;             // forecast horizon; 20 by default, changed only by a new version
  benchmarks: Record<AssetClass, string>; // the comparator per asset class; never chosen by an author
  costBps: number;                 // per-trade cost, taken from ResearchPolicy, not restated
  pClip: [number, number];         // e.g. [0.01, 0.99] for the log score
  minResolved: number;             // eligible resolved forecasts before a role's score moves allocation
  shrinkK: number;                 // shrinkage pseudo-count toward the pool
}
```

### 8.2 Forecasts on posts

```ts
/** Added to a `hypothesis` post's body; immutable and covered by the post hash like the registered test. */
export interface Forecast {
  event: { kind: "excess-return-sign"; symbol: string; direction: "long" | "short" };
  p: number;                       // probability the direction beats the benchmark net of costBps over horizonBars
  policyVersion: string;           // fixes horizonBars, the benchmark for the symbol's asset class, and costBps
}
```

Neither the window nor the benchmark is in the body. It starts at the first close strictly after the post's timestamp and ends `horizonBars` later, so no author can choose a convenient window, and the benchmark comes from the policy by asset class. One forecast per role per event per thread counts: a later forecast on the same event by the same role is recorded and ignored for scoring.

### 8.3 The resolution oracle

```ts
export type Resolution =
  | { kind: "resolved"; outcome: 0 | 1; excessReturn: number; barsHash: string; resolvedAt: string }
  | { kind: "pending"; dueAfter: string }
  | { kind: "void"; reason: "no-bars" | "delisted-not-survivorship-free" | "benchmark-missing" };

/** Pure: same forecast, post time and bars give the same resolution. */
export function resolveForecast(f: Forecast, postedAt: string, prices: PriceSource, asOf: string, policy: EconomyPolicy): Promise<Resolution>;
```

A delisting inside the window is an outcome, not a gap, when the source is survivorship-free (`PriceSource.survivorshipFree`); otherwise the forecast is void, because a source that drops delisted names would bias outcomes upward. `barsHash` pins the exact bars used, following the run-manifest rule that every computed result names its inputs.

### 8.4 Score rows

```ts
export interface ScoreRow {
  forecastPost: PostId;
  author: Author;                  // role, id, lineage, stamped by the coordinator
  template: string; modelId: string;
  modelCutoff: string | null;      // from the model catalog entry for modelId; null when the catalog has none
  p: number; outcome: 0 | 1;
  brier: number; log: number;      // log uses p clipped to pClip
  eligible: boolean; ineligibleReason?: "before-cutoff" | "unknown-cutoff" | "replay-with-web" | "duplicate";
  resolution: Extract<Resolution, { kind: "resolved" }>;
  policyVersion: string;
}
```

Rows store the raw probability and outcome, not only the score, so any variance or skill statistic can be recomputed later; a trial ledger that omitted per-trial variance is the cautionary case. Only coordinators write rows, as with the trial ledger.

### 8.5 The desk allocation rule

```ts
/** Derived, never stored: rebuilt from the board each round. */
export interface ArmState { thread: ThreadId; alpha: number; beta: number; rounds: number; prior: { alpha: number; beta: number } }

/** Rebuild every arm from the board's records (value events and per-round spend), applying decay round by round. Rounds come from the recorded round clock (`at[round]` in the budget doc), and approvals are a list of times; there is no `asOf` argument. */
export function armsFromBoard(desk: DeskState, policy: EconomyPolicy): readonly ArmState[];

/** Pure and replayable: seed = hash(asOf, boardHash), never the run id, so a re-run draws the carves its wake keys expect. */
export function allocateRound(
  arms: readonly ArmState[], roundBudget: Micros, caps: (t: ThreadId) => Micros, policy: EconomyPolicy, seed: string,
): readonly { thread: ThreadId; carve: Micros; sampledRate: number }[];
```

The allocation and its sampled rates are written to the round summary, so an operator can see why a thread was funded. `caps` carries the existing limits (thread round maximum, remaining lifetime budget, child floor) so the bandit never restates them. The bandit also never carves past a thread's pending demand (the total carve of its planned tasks), since ranked filling would otherwise give the top thread budget it cannot use (`allocateRound`).

## 9. Guards against Goodhart and noise

Design for an extension that is not in this repository.

Any measured signal that controls money gets optimized against, whether by a policy tuned toward it or by agents whose prompts mention it (Goodhart's law; general knowledge). The guards follow from asking, for each signal, what the cheapest way to move it is.

The cheapest way to move Stage 1's reward is to farm easy value events. Three rules close that. A value event counts once per load-bearing claim, so re-reproducing a reproduced finding earns nothing. Every event needs a deterministic basis, the same rule that stops a model from declaring its own evidence state. And the reward goes to a thread's allocation, never to an agent's budget, so no agent gains anything from farming even if it tried.

The cheapest way to move a Brier score is to forecast only easy events or to sit at the base rate. Scores are therefore compared as skill against a reference, the Brier skill score against the base rate of the same event class over a trailing window, so a role that always says the base rate scores zero skill however low its raw Brier. One forecast per role per event closes the spam route.

Noise is the larger risk. A binary excess-return outcome over a few weeks is close to a coin flip for most hypotheses, and a forecast near 0.5 has a Brier score near 0.25 whatever happens, so telling a skilled role from an unskilled one plausibly takes hundreds of resolved forecasts (no variance has been measured; general knowledge). Two guards follow. No role's score affects allocation before it has `minResolved` eligible resolved forecasts. After that, its skill enters as a shrunk estimate, (*n* × role mean + *k* × pool mean) / (*n* + *k*) with *k* = `shrinkK`, so a small sample moves allocation only a little; Stage 1's pooled thread priors use the same shrinkage. The first deliverable of Stage 2 is to measure the score variance on real resolutions and set `minResolved` from it, instead of guessing.

Two structural guards complete the set. The exploration floor keeps every open thread minimally funded, so a bad early posterior cannot starve a thread forever. And the policy is versioned: changing a weight, horizon or threshold is a new version, and rows computed under an old one are compared only with each other, as the research policy does for registered tests.

## 10. Vocabulary (E9)

Credential issuance creates no money and is called "issue" (`issueKey`, `issueToken`, `issueUiCookie`). Adding money to the root is a "top-up", journaled as `budget_topup`, and taking it out is a "withdrawal", journaled as `budget_withdrawal`.

The rest of the vocabulary follows Table 2: carve, reservation, settle, cancel, refund, grant, write-off, withdrawal. Words that imply wealth (wallet, earn, pay, reward, credits) are not used for budget. "Token" means a model token or a credential, never a unit of money.

## 11. Staged delivery

The design is staged so that each stage is usable alone. What exists in code, and what is design only:

**Built.** The conserved ledger of section 3: the hierarchical ledger in `packages/core/src/budget-ledger.ts` with its fail-closed ancestor walk, reservation against every ancestor in one store transaction, write-offs as `budget_overage`, journaled top-ups and withdrawals, and the grant path of section 13.

**Design only.** The conservation audits of section 3.3 (the property test over random Table 2 sequences, and the startup and `pomtree doctor` replay check with its journaled block and acknowledgement) are not built. Nothing in this repository implements the allocation policy or forecast scoring of sections 5.2 to 5.5 and 8: the bandit comparison against equal share (Stage 1), calibrated cost carves (Stage 1b), forecast resolution and score rows (Stage 2a), the training-cutoff field in the model catalog, and scores feeding allocation (Stage 2b). Those stages belong to a domain extension and are specified here so that the ledger and escalation mechanics leave room for them. Stage 1 becomes the policy only if a comparison of the two rules over the same recorded boards shows a gain, and that comparison is also the measured baseline the section 6 triggers refer to.

## 12. Settled decisions and reopen triggers

Each decision names the condition that reopens it.

1. **Stage 1 allocation (E4).** Equal share stays until a measured comparison shows a bandit gain; seeded Thompson sampling is the candidate, seeded from `asOf` and a board hash and rebuilt from the board each round (section 5.2). UCB is the fallback if single-number explanations come to matter more. Reopen on the Stage 1 comparison.
2. **Stage 1 reward weights.** Refutations and validations weigh the same by default, and user approval weighs most. The refutation-farming trigger is moot for document tests (a recomputed document test is never refuted, and `triviallyFalse` cannot fire on real boards); reopen on the measured share of trivially false runner-refuted hypotheses on recorded boards; the candidate guards are a per-thread refutation cap or a minimum declared test cost.
3. **Allocation score (E5).** Brier, because the skill measure in section 9 is the Brier skill score; the log score is kept for diagnosis. Reopen if the skill measure changes.
4. **Forecast event and horizon.** A binary excess-return sign over 20 bars is a versioned default, against a benchmark fixed per asset class in policy (20 bars is about one trading month; general knowledge). Reopen on the Stage 2a variance measurement. A continuous score (the continuous ranked probability score on the return [2]) would need distributional forecasts that models state poorly.
5. **Training cutoff.** A field of the model id in the model catalog, not of the template; unknown means ineligible, and a replay with web access is ineligible whatever the cutoff. Reopen if providers publish cutoffs in a form the catalog can import.
6. **Audit mismatch.** Journal replay over settled totals; a mismatch blocks new reservations, and the block and its acknowledgement are journal rows (section 3.3). Reopen on drift the journal cannot localize, or if reservations become journaled, which would let the replay cover escrow too.
7. **Lowering the root pool.** A journaled withdrawal of at most the unheld remainder, refusing only what is already carved (section 3.2). Reopen if the operator needs to reclaim a running agent's allowance, which would be a cancellation design, not a ledger one.

## 13. Budget exhaustion and escalation

This section describes what happens when an agent runs out of budget before it finishes. The short answer: it is parked, not killed. The agent's work is saved, a request for more money climbs the chain of authority, and a grant resumes it. Money moves only as section 3 allows: a grant is a transfer inside a subtree, never new money.

### 13.1 The problem

If exhaustion ended the agent, it would finish `over_budget` and its unpushed work would be lost with its folder. That loses good work more often than not, because an agent that stops one step short of a result is usually worth more than the few cents it needs to finish. Exhaustion is therefore treated as an escalation, a decision point for someone with a view of the wider work (section 4), and the agent holds nothing and spends nothing while it waits. Denial or timeout still ends it `over_budget`, as a fail-closed fallback.

### 13.2 The exhaustion ladder

Each model call goes through the model proxy, which reserves budget before forwarding (section 3.2). Exhaustion is detected in one of two ways, and both enter the same path (`escalateBudget` in `packages/pomtreed/src/daemon/budget.ts`).

1. The proxy refuses a reservation with a 402 tagged `model_budget_exhausted` because the agent's remainder, after in-flight requests, is below the minimum a call needs. This is the usual trigger: the proxy reserves the worst-case output cost, so a refusal arrives while real spend is still below the budget, and no usage event ever shows an agent over budget. Pi surfaces the 402 body in an `error` event, and the daemon matches the tag, not the phrase (`isBudgetRefusal` in `budget-raise.ts`).
2. The daemon's drive loop sees spend at or past the budget.

The daemon then opens a `budget_raise` approval first and parks the agent second. The order matters: a crash after a park with no approval would strand the agent, because nothing wakes it. The approval carries the requested amount, and a `budget_escalated` journal row on the asker records the approval id, requested amount, spend and budget. The park is a yield with a null wait: the workspace is committed, the session file is saved, a checkpoint is written, the agent is marked `yielded` and its container stops. Nothing satisfies a null wait, so no message, timer or child exit wakes the agent. A guard (`isBudgetParked`: yielded, with a `budget_raise` approval for its current generation) keeps the resume, interrupt and approval-hop paths from waking it; only the grant hook resumes it. A message sent to a parked agent is queued, and an explicit resume is refused with 409 `budget_pending`. The operator UI shows a user-bound `message_sent` on the `ui` channel, "<asker> out of budget; approve +$X?".

If approvals are not configured, or the park fails before its checkpoint, the escalation fails closed: the agent ends `over_budget` (a failed park first withdraws its own approval, so nobody grants into an agent that is about to fail). A reported result is respected: an agent that already reported its result settles on it instead of failing `over_budget`.

### 13.3 Who decides: the approval ladder and its windows

The approval climbs the ancestor chain nearest-first, then the operator, then the owner: for a child agent the rungs are its ancestors, `operator`, `owner`; for a top-level agent the chain is empty and the rungs are `operator`, `owner`. A deciding authority must outrank the requester, and a timeout past the top rung is a denial (fail closed). Each rung has its own window, stored when the approval is created and re-armed when a rung lapses. A human rung on a `budget_raise` waits `budget.raiseMs`, a long window because a yielded agent costs nothing while it waits and a short one would bring the loss of work back; an agent rung waits `escalation.agentRungMs`. The worst case for a child with several unanswered rungs is therefore the sum of its windows. A parked ancestor is skipped as an approval hop and the request bubbles past it. The approver may pass, approve the requested amount, or approve an explicit grant. The operator UI's Inbox approves the requested amount only; the CLI takes `pomtree decide <approval> approve --grant $USD`. The defaults are in the [`budget`](configuration.md#budget) and [`escalation`](configuration.md#escalation) key groups.

### 13.4 The grant: size, payer and carve

The requester proposes the amount: the overshoot it already spent past its budget plus `budget.raisePct` percent of its original budget (default in the [`budget`](configuration.md#budget) keys), where original means the current budget minus earlier grants (`requestedRaise` in `budget-raise.ts`). A granted agent therefore resumes with that percentage left to spend. In the hierarchical ledger the overshoot is already booked against the payer, so the grant costs the payer only the headroom (`grantCostMicros`).

The deciding ancestor pays from its own remaining budget, and an operator or owner grant draws from the root's remaining budget. The grant carves a slice down the chain: the payer's remaining falls, and each agent between the payer and the asker has its budget raised by the same amount, so each stays inside its parent's carve. Before the first raise the daemon checks that the payer's signed remaining covers the cost; a payer already overdrawn by a booked overage cannot grant even a zero-cost raise. A grant the payer cannot cover is refused with 409 `insufficient_budget` and moves nothing. If the payer is no longer a live ancestor, the asker has exited, or its generation has moved on, the raise moves no money and the escalation is denied. Grants appear in the journal as `budget_granted` on the asker, with the approval, amount, payer and new budget.

### 13.5 Resume

The grant hook (`applyBudgetDecision`) is the only path that resumes a parked agent. It acts on the agent's latest budget approval, runs only once the agent is fully parked (a yield returns before the container's slot is released and its key revoked, so the hook re-runs from the yield's settle step), and is safe to call from the approval-decide path, the yield settle, the approval sweep and reconcile. On approval it serializes against spawn carves of the same budget, carves the slice, journals the grant, shifts the session deadline (section 13.9), and resumes the agent as the next generation in a new container with a freshly issued credential. The proxy derives the per-credential cap from the budget when it issues the credential, and the debit store's `setBudget` lets a raised budget take effect; resume passes the total budget, so the stale remaining of the checkpoint (zero after exhaustion) cannot clamp the raise back to zero. The credential issued before the park stays dead. The wake text (`budgetWakeText`) tells the agent what it was granted and by whom, and that tool calls in flight when it stopped were aborted and may have partly run. On denial or timeout the hook journals `budget_denied` and finishes the agent `over_budget`, keeping its folder and checkpoint.

### 13.6 Parent and child accounting

A parent's consumption counts each unreaped child's full carve, so a raise to a child reduces the parent's remaining budget with no new bookkeeping, and the grant is charged to the grantor. Slack accounting follows from the carve down the chain: an intermediate agent's budget and consumed rise by exactly the grant while its remaining is unchanged. If the parent is itself exhausted, the request climbs the rungs. An operator grant to a top-level agent draws from the root's remaining budget.

### 13.7 Idempotency, fencing and repeated requests

The approval id is deterministic from the asker, generation and requested amount, so a late decision aimed at an old generation changes nothing, a replayed decision is a no-op, and a decision against a stale generation is rejected. At most one budget approval exists per agent per generation: a second exhaustion in the same generation reuses the open approval, and the yield is keyed per generation, so repeated refusals produce one escalation. Every step of the grant is keyed, so a crash at any point replays to completion; a crash in the middle of the raise leaves harmless slack, never a double grant. `finish` is a no-op on an exited agent, so when a denial races a wake the first exit wins.

### 13.8 Capacity, interactive Pi and keep-open

A budget-blocked agent yields instead of waiting. A yielded agent releases its placement and so frees its admission slot, while a waiting agent holds one for as long as it waits; holding a slot for up to the full approval window would stall other agents, and `waiting` already means "turn settled, awaiting a human reply". This is the same trade the waits-yield rule makes.

Pi runs interactively in a terminal container and stays open after a turn (keep-open). Yield and resume are consistent against it: at a turn boundary the session file is newline-terminated with no torn tail, the checkpoint's session hash matches, context survives, and one spend ledger spans the generations. A yield in the middle of a tool call kills the tool: the session then holds the assistant's tool call with no result, Pi does not replay it, and after the wake message the model may choose to re-run it, so tool effects are at-least-once and model-driven. This is why the wake text warns about aborted calls, and why yield needs no turn-boundary restriction. A yield with a token stream in flight has not been exercised and is expected, but not shown, to behave like the mid-tool case. Because interactive Pi exits with code 0 even on SIGTERM, a budget park is recognized from daemon state (yielded, with an open `budget_raise` approval for its generation), never from the container's exit code. The terminal connection ends when the container stops. Known gap: the per-agent terminal view has no "yielded: awaiting budget approval" banner or reconnect after resume; the operator sees the approval and the `ui` message instead.

### 13.9 Watchdog, warnings and deadlines

The watchdog's `budget` reason (spend reaching 90 percent by default) is advisory: it never climbs the watchdog ladder and instead sends the agent a `budget_warning` signal, once per generation, urging it to run `pomtree push` before the budget runs out. The watchdog sweep lists only `running` agents, so a parked agent is outside it. There is no grace window past the budget: since exhaustion parks instead of killing, one is unnecessary.

A spawn deadline is different. While an agent is parked the session wall-clock is paused, and on a grant the deadline is shifted by the parked duration, so the wait does not consume the deadline's time. A parked agent whose deadline passes anyway (it was parked at the deadline, or the grant never came) is finished `timed_out`, so for an agent with a deadline the whole approval wait must fit inside the time remaining or the deadline wins. A child cannot outlive the deadline of the requester that spawned it.

### 13.10 Crash semantics

Daemon restart while parked: the agent is `yielded` with a durable checkpoint and a durable pending approval, and the approval sweep re-arms the rung windows across restarts, so a restart neither resumes nor double-grants. A crash during the yield itself is covered by the yield's `pausing` marker.

A reservation in flight when pomtreed dies is never settled by anyone. After the restart the daemon expires it once it is older than twice `model.upstreamTimeoutMs` and charges it at its full reserved maximum, even if the provider billed less or nothing. This is fail closed: the daemon cannot tell what the provider billed, and undercharging would let a crash loop spend past a cap. It may overcharge; it never undercharges. A small agent's first call can reserve its entire budget, so after such a crash the agent can be left with a remainder below the per-call minimum. A running agent's drive loop turns the proxy's 402 into an escalation, but an agent re-adopted after a restart has no drive loop, so the proxy reports every below-minimum refusal to the daemon (`onBudgetStall`, handled by `escalateStalled`), which raises the same escalation: approval first, then park, once per stall however many calls are refused. The `budget_escalated` row then also carries the remainder, the minimum and a message naming the fix. The thinking-budget clamp's 402 does not escalate, since the agent can fix that itself. When approvals are not configured or the escalation cannot be opened, the agent keeps running with its calls refused, and one `error` journal row per generation names the cause and the action (configure approvals and restart, or `pomtree cancel`). Known gap: a refusal that arrives before an adopted agent's container is attached is dropped, and only the next refused call reports it again, so an adopted agent that makes no further call stays unescalated.

A charge bounded by an estimate (for example from the request size) is not used, because an estimate can undercharge. Reopen if a provider exposes a per-request billed-cost lookup the daemon can query after a restart.

### 13.11 Escalation through the ancestor chain

A grant through a nested chain behaves as follows, for an asker C under ancestors B (nearest) and A, below the operator and owner. The rungs are B, A, operator, owner, pending at B. B receives the escalation signal and is woken; A has no signal and the user sees nothing; A cannot yet decide (403). B can approve, pass or deny. If B's approval or an explicit grant exceeds what B can cover, it returns 409 `insufficient_budget` and moves nothing. A pass advances the approval to A: B's signal is acknowledged, A's is delivered and A is woken, replaying the pass is a no-op, and B can no longer decide. When A approves, only A's remaining falls; B's budget and consumed rise by the grant with B's remaining unchanged, C's budget rises, and C resumes at the next generation with a new credential. A timeout hops the same way: each lapsed rung's signal is acknowledged and a user-bound `ask` message appears on the `ui` channel when the holder reaches the operator. A plain `pomtree ask --wait` bubbles through the same hops. Known gap: ancestors that are model-driven agents deciding from the escalation text have not been exercised end to end; the chain mechanics above are exercised with ancestors driven through the same routes `pomtree decide`, `answer` and `pass` use.

## Sources

Retrieved 2026-11-04. Each source was checked at the listed page or its bibliographic record; papers were confirmed from abstracts and records, not read in full.

1. SchedMD, "Fair Tree Fairshare Algorithm," Slurm documentation. https://slurm.schedmd.com/fair_tree.html; classic formula, including usage decay by half-life: https://slurm.schedmd.com/classic_fair_share.html
2. T. Gneiting and A. E. Raftery, "Strictly Proper Scoring Rules, Prediction, and Estimation," *Journal of the American Statistical Association* 102(477):359–378, 2007. doi:10.1198/016214506000001437
3. V. Buterin, Z. Hitzig and E. G. Weyl, "A Flexible Design for Funding Public Goods," *Management Science* 65(11):5171–5187, 2019; preprint 2018, arXiv:1809.06421.
4. S. Fish, Y. A. Gonczarowski and R. I. Shorrer, "Algorithmic Collusion by Large Language Models," arXiv:2404.00806, first version 2024.
5. E. Karger et al., "ForecastBench: A Dynamic Benchmark of AI Forecasting Capabilities," ICLR 2025; arXiv:2409.19839.
6. R. Hanson, "Logarithmic Market Scoring Rules for Modular Combinatorial Information Aggregation," *Journal of Prediction Markets* 1(1):3–15, 2007; working paper 2002.
7. M. S. Miller and K. E. Drexler, "Markets and Computation: Agoric Open Systems," in B. A. Huberman (ed.), *The Ecology of Computation*, North-Holland, 1988. https://papers.agoric.com/papers/markets-and-computation-agoric-open-systems/abstract
8. D. J. Russo, B. Van Roy, A. Kazerouni, I. Osband and Z. Wen, "A Tutorial on Thompson Sampling," *Foundations and Trends in Machine Learning* 11(1):1–96, 2018. doi:10.1561/2200000070
