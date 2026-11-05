# Publishing REC Exam Browser

What a college does with a build once CI has produced one, and what a
candidate's machine then downloads. The application itself is
`apps/exam-browser`; `docs/EXAM-BROWSER.md` is what it is and what it is
worth, and §8 is the release shape this directory implements.

---

## Why the college publishes it, and not us

`/exam-browser` tells a candidate to ask their department for the installer
rather than offering a download from anywhere else. That is deliberate. A
candidate is being asked to install software on their own machine to sit an
exam; the least they are owed is that the copy they install is one their
own department can vouch for, served from the hostname they already sign in
to.

It also closes the obvious attack. The application registers the
`recx-exam://` scheme system-wide, so any page the candidate visits can
start it — `apps/exam-browser/src/config.ts` explains why the exam origin
is compiled in rather than read from the launch URL. None of that helps if
the candidate installed a build somebody else published.

---

## The layout

Everything under `public/` is served by Caddy at
`/downloads/exam-browser/`, as files, outside the application (see the
`@installers` block in `../Caddyfile`). Nothing here is read by REC Code.

```
deploy/exam-browser/
  README.md                            this file
  latest.json.example                  the manifest's shape
  public/                              NOT in git; created on the host
    latest.json
    REC-Exam-Browser-1.0.0-win-x64.exe
    REC-Exam-Browser-1.0.0-mac-arm64.dmg
    REC-Exam-Browser-1.0.0-linux-x64.AppImage
```

`public/` is deliberately absent from this repository. Installers are build
output, they are tens of megabytes, and the signed ones are produced by CI
from secrets that are not here. Point `RECX_EXAM_BROWSER_DIR` at wherever
the host keeps them if `./exam-browser/public` is not it.

Artefact names carry their version, so a name never points at different
bytes — which is why Caddy serves them `immutable` for a year.
`latest.json` is the one thing that changes, and it is served `no-store`.

---

## Publishing a build

1. **Build and sign in CI.** `pnpm --filter @recx/exam-browser release`
   produces the installers into `apps/exam-browser/release/`. Signing
   happens in CI from secrets that are not in this repository; a local
   build is unsigned and electron-builder says so.
2. **Copy the artefacts** into `public/`, alongside the ones already there.
   Do not delete the previous build: a candidate part-way through
   installing, or a hall that has not updated yet, still needs it.
3. **Write `latest.json`** (see `latest.json.example`). This is what tells
   a candidate's readiness check which build is current.
4. **Check one download** from outside the college network, on each
   platform you published. A 404 here is a hall that cannot sit.
5. **Only then** consider raising the version floor.

## Raising the floor, which is a different decision

`latest.json` says what is current. The **floor** says what is refused, and
it is set on `/super/settings/integrations`, not here. They are separate on
purpose:

* publishing a build inconveniences nobody;
* raising the floor refuses every candidate whose installed copy is older,
  **from their next request onwards, including candidates part-way through
  a paper.**

So raise it when a build is known to be bad, not as housekeeping, and not
during a sitting. The audit row records the previous value and the new one,
because "what was it before" is the first question anybody asks when a hall
cannot start.

## Taking a build out of service

Raise the floor above it. Do not delete the installer: a candidate who
cannot download the build they are being told to install is in a worse
position than one running an old one, and the floor already refuses the
old one.
