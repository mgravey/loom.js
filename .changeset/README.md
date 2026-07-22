# Changesets

Add a changeset for every user-visible change to a public `@mgravey/loom-*` package:

```sh
pnpm changeset
```

Use `patch` for compatible fixes, `minor` for compatible features while packages remain below 1.0,
and `major` only when intentionally moving a package to a new major line. Private examples and
experimental packages are excluded from publication.

Maintainers prepare versions with `pnpm version-packages`, review the versions and dependency
ranges, update the repository-level `CHANGES.md`, run `pnpm release:pack`, and publish with
`pnpm release:publish`.
