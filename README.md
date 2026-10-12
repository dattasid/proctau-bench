# proctau-bench

Procedurally generated tau-bench-style evals: randomized banks, policies and tasks, rule-audited gold answers, and a script-controlled customer.

Work in progress.

## What it is

A benchmark for customer service agents that use tools, set in a bank. It follows the shape of
[tau-bench](https://github.com/sierra-research/tau2-bench): an agent talks to a simulated customer,
reads the bank's policy documents and calls the bank's API. The end state and the calls are then
checked.

The difference is that nothing is fixed. Every bank is generated from a seed, and so are its tasks.

## What is new here

**Randomized rates and policies.** Each seed gives a different bank: its products, interest rates,
fees, fee waivers, opening requirements and policies such as identity checks, courtesy refund caps
and transfer limits. The bank's config is the single source of truth. The agent's documents, the
API's checks and the tasks' answers are all derived from it.

**Policy checks on every API call.** Each tool call is checked against the config's policies: was the
customer verified, are they eligible for this product, is this refund a valid correction, is this
transfer over the monthly limit. Every check is recorded in a trace, call by call, so it can be used
as a reward signal, not just a final pass or fail.

**Randomized task generation.** A task template builds a customer and an account history that land
on one branch of a rule, then replays the expected calls to confirm it. Histories are built to make a
rule come out true or false and are checked against the rules. Mistakes can be planted on purpose,
such as a fee charged although the waiver was met, and an independent audit must find exactly the
planted ones.

**A customer controlled by code.** An extractor LLM turns each agent reply into machine-readable
acts, such as `request_info(field="date_of_birth")` or
`mentions_eligible_date(product="Gold Savings", date="2026-05-02")`. Plain code then decides the
customer's next move from a script, and an LLM only puts that move into words, with code checking
that names, dates and amounts survived. The customer cannot drift off script, however long the
conversation. It can also be told to make mistakes, like giving a wrong date of birth first and
correcting it when asked.

## Tasks today

- Open an account when eligible, or when a required account was held too briefly
- Get a monthly fee refunded: charged in error, valid with courtesy refunds left, or valid with the
  yearly cap reached
- Report a card purchase you didn't make, or ask for something the policies don't cover (both should
  be handed to a human)
- Move money between your own accounts, within or over a monthly limit
- Ask which account pays the most interest on an amount, and open it

## Quick start

Needs Node 22.6 or later.

```sh
npm install
npm test
npm run generate -- --seed 1 --count 3      # writes banks to out/
```

Running conversations needs an [OpenRouter](https://openrouter.ai) key in a file named
`OPENROUTER_API_KEY` (it is gitignored) or in the environment variable of the same name.

```sh
npm run harness -- --list-templates
npm run harness -- --seed 1 --count 3 --customer scripted
npm run view                                # browse the runs at http://localhost:8788
```

## Pending

- Broader use-case coverage for tasks, and generating the starting database for them
- Document search: the agent finds the policies it needs with search tools, instead of getting every
  document in its prompt
- Benchmarking across models

## Credits

Inspired by tau-bench and tau2-bench by Sierra Research. The agent and customer prompts are adapted
from tau2-bench under the MIT License; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
