# Control-level UI policy

Set `DSH_UI_CONTROL_POLICY` to a version-1 JSON policy file. It is optional and disabled when
unset. `samples/ui-control-policy.example.json` contains a generic order-submission example.
This structured mechanism supplements the existing `DSH_UI_DENY_RE` expression.

Each deny rule has a unique ID, actions, regex selectors (`name`, `aid`, `container`), a reason,
an alternative and `examples.match` / `examples.not_match`. Specified selectors intersect.
Container matches any actual ancestor name or AutomationId. Matching is case sensitive.
Both JavaScript and PowerShell validate regexes and examples. Invalid policies deny all
side-effect actions with `control_policy_invalid`; read-only observations remain available.
`ui_status.controlPolicy` reports unconfigured, loaded count, or invalid with the reason.

The executor checks the resolved control, so selecting a denied name by AutomationId or index
does not bypass the rule. Denials return `control_denied`, `ruleId`, `reason` and `alternative`.
Flows and replays preflight all steps before any executes and recheck each actual action.
Targets that only appear after earlier actions cannot be preflighted: split the flow into
observe-and-act steps. Coordinate actions (`clickat`, `drag`, `move`, `wheel`) have no resolved
control name and cannot match these selectors; existing coordinate and application gates remain.

```sh
node scripts/ui-policy-check.mjs --policy samples/ui-control-policy.example.json
node scripts/ui-policy-check.mjs --policy policy.json --action click --name Submit --aid SubmitButton
```

The checker lists example results and exits 0 for a valid policy or 1 for an invalid policy.
Optional target arguments print the decision. Supplying a sample file does not enable it.
