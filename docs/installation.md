# Installation and bootstrap

## 1. Install the supporting tools

Use exact versions from `.harness/harness.lock`. Pi is an npm package; Spec Kit
supports a pinned `uv tool install ...@vX.Y.Z`; Herdr supports stable binaries
and pinned Nix release refs. Worker authentication is separate from installing
their CLIs.

The harness divides setup into three approvals:

1. **Install approval** approves one content-addressed dependency plan.
2. **Authentication** signs Pi, Codex, Devin, Claude, GitHub, or Herdr into
   disposable development accounts. Bootstrap never captures tokens.
3. **Run approval** approves the effects preview for a particular feature run.

## 2. Initialize a project

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness init .
```

This creates `.harness/workflow.yaml`, `environment.yaml`, `policy.yaml`,
`harness.lock`, three workflow variants, and `.pi/settings.json`. It refuses to
overwrite existing files. The generated workflow DSL is meant to be edited and
committed.

`environment.yaml.agent_plugins` is the portable plugin inventory. The shipped
default binds Superpowers to its provider-specific identity in Pi, Codex,
Devin, and Claude. Doctor checks every declaration against the locked version;
the aggregate `superpowers` capability is healthy only when all declared agent
plugins are present and enabled.

## 3. Probe and approve installation

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness bootstrap --dry-run .
```

Review `planHash`, every source/digest, argv, scope, mutation, and rollback
hint. Floating Git refs, local paths, unknown sources, wrong-source installs,
unexpected Pi packages, and unverifiable state are manual blockers.

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness bootstrap --yes .
```

`--yes` approves only the exact displayed hash; it does not broaden policy or
bypass manual blockers. Use `--repair` only after inspecting a disabled or
customized declared Pi package entry. Repair never deletes an undeclared
package.

## 4. Diagnose

```bash
harness doctor --json .
```

Doctor freshly checks required versions, project-local Pi resources, worker
CLIs, authentication status, policy violations, and configuration. Receipts are
diagnostics, not proof that the current machine is healthy.

## 5. Start the controller

```bash
harness start .
```

The command creates or reattaches one stable `pi` controller agent in Herdr. It
never starts a duplicate with the same repository identity.
