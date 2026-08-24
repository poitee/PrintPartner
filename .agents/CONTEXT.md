# Print Partner

Print Partner turns design sources and customer requirements into a reviewed printable Build.

## Language

**Source role**:
The relationship a supplied Source has to one Build, such as canonical design, vendor overlay, mod, or evidence. It does not change the Source's Library organization.
_Avoid_: Global role, category

**Functional slot**:
A replaceable or composable responsibility in a Build, such as toolhead, extruder, hotend, probe, toolhead electronics, cable routing, or controller.
_Avoid_: Source category, layer type

**Source contribution**:
A path-scoped claim that a Source supplies printable parts or evidence for one functional slot.
_Avoid_: Add-on, component

**Source category**:
A user-managed label for organizing Sources in the Library. It has no compatibility or replacement meaning.
_Avoid_: Functional slot, Source role

**Build requirement**:
A customer constraint that the planning workflow must verify, satisfy, waive, or mark incompatible before accepting the Build.
_Avoid_: Option, preference

**Difference group**:
A review grouping for individual differences between Sources with overlapping responsibility. Resolving a group records a decision for every underlying difference without hiding them.
_Avoid_: Conflict
