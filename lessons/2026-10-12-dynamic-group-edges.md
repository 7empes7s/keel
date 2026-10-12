# Dynamic-group member edges (2026-10-12)

| Mistake | Rule now |
| --- | --- |
| Member `$ref` add/remove was planned for every group. Graph rejects `$ref` member writes to a dynamic-membership group, so the edge failed and the whole restore run stopped. | `planRelationshipOperations` reads the parent's `groupTypes`. A `DynamicMembership` group gets no member edge and a plan note ("membership comes from the membership rule; restore the rule instead"); its membership comes back through the group update, which carries `membershipRule` and `membershipRuleProcessingState`. Owner edges are still planned. |
| A relationship planner that cannot see the parent payload cannot know which edges Graph will accept. | Pass the parent's type-defining fields into edge planning, and fixture-test one group of each kind (dynamic, Unified, static) whenever a per-type Graph rule applies. |
