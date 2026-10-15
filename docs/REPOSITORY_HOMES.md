# Repository homes

A repository home is a shareable starting page for work on one repository. On the normal home page,
select a repository and click **Open repository home**, then bookmark or share the resulting URL.
For example:

```text
https://your-open-inspect.example/?homeRepo=acme%2Fwebsite
```

The page shows the repository name and fixes the session target to that repository. Users can still
select a branch, write a prompt, and use the usual model and session access controls. The link takes
precedence over saved target preferences and team environment defaults, without replacing the saved
preference for the normal home. If the repository is unavailable in the selected team, session
creation is blocked; the page never silently chooses another repository.

The sidebar lists only sessions containing that repository, including sessions where it is a
secondary repository. Filtering applies before pagination and hierarchy grouping. A matching child
whose parent uses another repository appears as a separate entry. **Mark all read** applies only to
the repository view. Sidebar session links, new-session actions, and quick search retain the home
scope. Click **All repositories** on the home page to return to the normal starting page.

Nested owners are supported: `group/subgroup/site` is the `site` repository owned by
`group/subgroup`. URL-encode the complete `homeRepo` value when constructing a link manually.

Repository homes simplify navigation; they do not grant or revoke access. Existing workspace and
team permissions still apply. Users can leave the repository home or edit its URL. Each link scopes
one repository; custom persona layouts and a home covering a set of repositories are not part of
this feature.
