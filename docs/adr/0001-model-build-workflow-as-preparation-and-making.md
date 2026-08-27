# Model the Build Workflow as Preparation and Making

PrintPartner represents Build work as `Sources -> Plan -> (Production <-> Checkoff)`, with Plan acceptance as the safety boundary between editable intent and printer work. A single read-only Build Workflow projection computes status and the next safe action for the UI and MCP, while existing domain modules continue to own mutations. This rejects a linear four-step model because Production and Checkoff repeat, and it prevents each client surface from inventing different completion rules.
