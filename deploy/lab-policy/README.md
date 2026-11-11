# Exam lab browser policy

Two files, one policy: `chrome-policy.json` for Linux and ChromeOS,
`recx-exam-policy.reg` for Windows. They configure the browser on a
**college-owned lab machine** for an assessment sitting.

This is the control `docs/PROCTORING.md` §4 lists first — "a supervised lab
on college-managed machines" — turned into something an administrator can
install and an invigilator can verify. Until now it was a sentence in a
document.

---

## Why this exists, and why it is not "require a private window"

The obvious idea is to make proctor mode insist on an incognito window, on
the reasoning that extensions do not run there. It does not work, in three
separate ways, and each of them is enough on its own:

1. **A page cannot tell.** There is no API for it. Chrome treats
   private-mode detectability as a leak and has closed each one found (the
   FileSystem probe in Chrome 76, the storage-quota probe after it). What is
   left is a version-specific heuristic that reports Guest mode and some
   ordinary profiles as private. A sitting gated on it would refuse honest
   candidates at random, on the morning of the exam, which is the worst
   moment available to be wrong.
2. **A private window is not extension-free anyway.** Chrome has a
   per-extension *Allow in incognito* toggle — two clicks, no restart. Add
   developer-mode unpacked extensions, a second profile, and
   `--load-extension` on the command line, and the guarantee the idea rests
   on was never there to begin with.
3. **A page cannot see extensions at all, private window or not.**
   `chrome.management` is available to extensions only, and probing
   `web_accessible_resources` finds only extensions that publish a known
   resource. One written for this purpose publishes nothing. This is in
   `docs/PROCTORING.md` §2 as a property of browsers, not as a gap in our
   work.

So "no extensions" is not something a web page can require, verify, or even
observe. It is something the **owner of the machine** can impose, and only
there. That is this directory.

What the private-window idea actually wants — *a clean browser for the next
candidate* — this policy does properly, with `ClearBrowsingDataOnExitList`:
history, cookies, cache, saved sign-ins and autofill are cleared when the
browser closes. Managed, verifiable, and without private mode's own hazard,
which is that a window closed by accident takes the candidate's session with
it and makes them sign in again against a running clock.

**Nothing here claims the sitting is secured.** A policy on the machine
raises the cost of the easy routes. It does nothing about the phone on the
candidate's lap, which `docs/PROCTORING.md` §2 calls the largest hole, and
which only a human in the room addresses.

---

## What each key does

**The profile is the college's, not the candidate's.** This group carries
the weight: without it the extension blocklist below is one Google sign-in
away from irrelevant, because Chrome Sync would install the candidate's own
extension set on arrival.

| Key | Value | Effect |
| --- | --- | --- |
| `BrowserSignin` | `0` | Signing in to Chrome is disabled. |
| `SyncDisabled` | `true` | No profile, extension or bookmark sync. |
| `BrowserGuestModeEnabled` | `false` | No guest profile. |
| `BrowserAddPersonEnabled` | `false` | No second profile. |
| `IncognitoModeAvailability` | `1` | Private windows disabled — see above. |

**No extensions.**

| Key | Value | Effect |
| --- | --- | --- |
| `ExtensionInstallBlocklist` | `["*"]` | Every extension is blocked, including ones already installed and ones a user would enable in a private window. |
| `ExtensionInstallAllowlist` | `[]` | Narrow exceptions go here, by ID, and each one is a decision somebody signs for. |
| `ExtensionInstallForcelist` | `[]` | Where a college extension (seat reporting, device attributes) would be force-installed. Empty, and `docs/handoff/SPEC.md` §5 keeps it that way: the platform must be fully functional without one. |

**One destination.** The exam app is same-origin by construction — its
content security policy is `default-src 'self'` with no external host in any
directive (`apps/web/src/middleware.ts`) — so an allowlist of exactly the
exam host is enough to load it. `chrome://policy` and `chrome://version`
are listed because a blocklist of `*` covers those pages too, and
`chrome://policy` is how the invigilator verifies all of this.

| Key | Value | Effect |
| --- | --- | --- |
| `URLBlocklist` | `["*"]` | Nothing loads unless it is allowed below. |
| `URLAllowlist` | exam host, `chrome://policy`, `chrome://version` | The exam, and the two pages that prove the machine is set up. |
| `DefaultSearchProviderEnabled` | `false` | The address bar stops being a search box. |
| `RestoreOnStartup`, `RestoreOnStartupURLs`, `HomepageLocation`, `HomepageIsNewTabPage` | the sign-in page | The machine opens where the candidate needs to be, and the home button goes there rather than to a new-tab page the blocklist would empty anyway. |

**Nothing leaves the machine.**

| Key | Value | Effect |
| --- | --- | --- |
| `DownloadRestrictions` | `3` | All downloads blocked. |
| `PrintingEnabled` | `false` | No printing, and no print-to-PDF of the paper. |
| `ScreenCaptureAllowed` | `false` | Pages cannot capture the screen. The operating system's own screenshot key still works: this is a browser policy, not a camera in the room. |
| `ClearBrowsingDataOnExitList` | history, downloads, cookies, cache, sign-ins, autofill, site settings | The next candidate starts clean. |

**Fewer ways to leave a password behind on a shared machine.**

| Key | Value | Effect |
| --- | --- | --- |
| `PasswordManagerEnabled` | `false` | The browser never offers to save the candidate's password. |
| `AutofillAddressEnabled`, `AutofillCreditCardEnabled` | `false` | Nothing personal is retained to autofill. |

**`DeveloperToolsAvailability: 2`** closes devtools, and it is worth saying
plainly what that is and is not. It makes the page harder to inspect on
*this* machine. It is not detection, and the product still does not try to
detect devtools anywhere: `DEVTOOLS_HEURISTIC` is a reserved signal kind in
`packages/shared/src/exam-telemetry.ts` precisely because the in-page
heuristics are unreliable in both directions. Closing a door on a machine
you own is a different act from guessing through it on a machine you do not.

**Deliberately not set:** `TranslateEnabled`. Translation is an
accessibility affordance for students who do not read English first, and
`Accommodation` exists in this product to widen access rather than narrow
it. A college that decides otherwise for a particular paper should write
that decision down with the paper rather than inherit it from a file.

---

## Installing

Replace `exam.rec.invalid` with the real exam host first. It is a reserved
name that can never resolve, so a machine deployed with the placeholder
still in place fails loudly instead of quietly allowing some other domain.

**Linux (Google Chrome):**

```sh
sudo install -D -m 0644 chrome-policy.json \
  /etc/opt/chrome/policies/managed/recx-exam.json
```

For Chromium the directory is `/etc/chromium/policies/managed/`. The file
must be owned by root and must not be writable by the candidate's account —
that ownership is the whole of the enforcement, so check it rather than
assume it.

**Windows:** import `recx-exam-policy.reg` as an administrator, or set the
same keys under `HKLM\SOFTWARE\Policies\Google\Chrome` through Group Policy
with Google's ADMX templates, which is the better route for a managed fleet.

**ChromeOS:** set the same policies in the Google Admin console against the
device organisational unit. There is no file to copy.

Then restart Chrome.

## Verifying, in front of the candidate

`docs/RUNBOOK.md` §2.14 has this as a numbered pre-sitting check. The short
form: open `chrome://policy`, press **Reload policies**, and confirm each
key above is listed with source **Platform** and status **OK**. A key that
is missing, or whose source reads **Cloud** or **User**, is not in force.

Record that the check happened. An invigilator can do it from the
invigilation page — *Record what you saw*, against any candidate in the
hall, writes an `INVIGILATOR_NOTE`, which is context for a reviewer and, by
design, cannot raise a band on its own.
