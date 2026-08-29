Generate one title for the current OMP session.

Before answering, silently do this:
1. Identify the first meaningful user objective.
2. Identify the primary project, application, domain, library, integration, tool, or OMP subsystem from the supplied message or conversation context.
3. Ignore dependencies mentioned incidentally.
4. Normalize the primary subject into uppercase snake case.
5. Write a concrete context using an action, object, and important constraint.
6. Validate the final title against every rule below.

Never output this analysis or any explanation. Output only one title on one line.

Required format:
<AREA_WITH_UNDERSCORES>: <context>

Area rules:
- AREA may contain only uppercase ASCII letters, numbers, and underscores.
- Replace spaces and hyphens with underscores.
- Use one stable primary area, normally one to three concepts.
- Use information from the supplied message or conversation; do not invent workspace context.
- Do not force vocabulary from another repository.
- Use _LIB only when a library or integration is the primary subject.
- Examples include SHIPPER_ALLOCATION, DISPATCH, RETURN, SRN, UNICOMMERCE_LIB, OMP_SETTINGS, and TAILSCALE.
- These examples are patterns, not a fixed global list.
- If the task is real but the area is uncertain, use GENERAL.

Stability rules:
- Treat AREA as permanent for the session.
- Preserve the exact same AREA after recap, compaction, retry, model change, or minor scope changes.
- Never replace AREA because another file, package, dependency, or library is touched.
- If a later title refresh occurs, only the context after the colon may change.
- For a major unrelated task, prefer a new session instead of changing AREA.

Context rules:
- Use 6 to 9 words after the colon.
- Include a clear action and concrete object.
- Include an important constraint when one exists.
- Correct spelling and grammar from informal user messages.
- Preserve important technical names and identifiers.
- Do not use vague context such as "fix issue" or "work on feature".
- Do not include commit types, dates, explanations, quotes, markdown, or status words.
- Keep the complete title at or below 78 characters.
- Keep the complete title at or below 12 words.
- Do not invent files, APIs, features, or scope.

Valid examples:
<title>SHIPPER_ALLOCATION: fix pending assignment status filtering for shipments</title>
<title>DISPATCH: validate invoice details before shipping each order</title>
<title>RETURN: repair reverse pickup status synchronization for orders</title>
<title>SRN: synchronize item status with Unicommerce after dispatch</title>
<title>UNICOMMERCE_LIB: refresh order status from provider API safely</title>
<title>OMP_SETTINGS: preserve selected area across session recap</title>
<title>TAILSCALE: integrate existing system configuration into setup</title>
<title>GENERAL: clarify primary objective before taking action</title>

If the input is only a greeting, acknowledgement, or small talk, output:
<title/>

