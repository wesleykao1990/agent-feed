# Milestone 6 learnings

## M6-L001 — Transport reuse is stronger than schema copying

Importing the existing official server factory makes tool discovery, argument
rejection, and lifecycle routing identical by construction. A second set of
HTTP tool handlers would immediately create a drift surface.

## M6-L002 — MCP authentication is request context, not tool data

The resource server validates a token, maps it to a principal, and passes only
that principal into the shared application service. This prevents agents from
selecting tenant or producer identity inside model-generated arguments.

## M6-L003 — OAuth discovery and OAuth durability are separate claims

A correct DCR/PKCE exchange is sufficient for a live client acceptance test.
It does not supply persistent registration, multi-instance coordination,
revocation across restarts, operator identity federation, or production HA.

## M6-L004 — Modern MCP HTTP has header/body cross-checks

The 2026 protocol envelope is not the complete HTTP request contract. The
official entry also validates `Mcp-Method` and, for named operations,
`Mcp-Name`; conformance clients should exercise these rather than bypass them.

## M6-L005 — Body limits must be enforced while reading

Rejecting a large `Content-Length` is useful but does not constrain chunked
requests. The Node adapter must stop accumulating bytes as soon as the hard
limit is crossed.

## M6-L006 — Acceptance tests must follow lifecycle ownership semantics

Begin and completion each carry phase-specific metadata; terminal completion
does not promise to merge arbitrary begin metadata. A transport acceptance
test should verify durable identity, state, findings, and evidence without
adding a new metadata contract by assertion.

## M6-L007 — Claude plan support and connector-registration authority differ

Team and Enterprise members can connect to an owner-approved custom connector,
but only an Owner or Primary Owner can add it to the organization. A reachable
server and valid OAuth metadata cannot bypass that account authorization
boundary; the acceptance record must distinguish access blockage from protocol
failure.

## M6-L008 — Acceptance commands must name their execution environment

Installing a dependency into a repository virtual environment does not make it
visible to a different system Python. Likewise, a sandbox-denied localhost
socket is not evidence that an API or PostgreSQL contract failed. Combined
acceptance receipts should record the interpreter/environment and distinguish
an execution-environment failure from a product assertion failure.

## M6-L009 — File-linked packages require clean installs at each source root

Installing an application that links another workspace directory does not
guarantee that the linked directory can resolve its own local dependencies on
a clean GitHub runner. A milestone CI job must install the complete source-link
chain explicitly, and its architecture guard should fail when that list drifts.

## M6-L010 — Generated dependencies belong in the milestone runner

A clean install proves dependency resolution but does not create generated
package exports. When a required package intentionally excludes `dist/` from
source control, the milestone runner must build that dependency before testing
its consumers so local and hosted entrypoints exercise the same prerequisite.
