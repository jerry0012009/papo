# Harness Notes

This Demo borrows patterns from successful agent systems without importing a heavy orchestration framework.

## What We Borrow

LangGraph-style statefulness:

- The creature has durable state.
- Each interaction produces traceable state transitions.
- Memory is part of execution, not an afterthought.

Mem0-style memory discipline:

- Episode memory is append-first.
- Long-term memory is extracted from episodes after feedback or high value.
- User, session, and creature-self memories stay separate enough to evolve later.

Swarm/Agents-style loop:

- A run has clear steps: sense, attend, interpret, guardrail, remember, learn, emerge.
- The LLM can propose semantic interpretation and action.
- Product rules execute or reject proposals.

## Local Design Choice

Papo 1.0 uses a lightweight in-repo harness:

- No graph runtime yet.
- No vector database yet.
- No hidden memory writes by the model.
- No state mutation from unvalidated LLM JSON.

This keeps the Demo easy to modify while preserving the shape needed for future upgrades.
