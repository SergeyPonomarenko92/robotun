# Robotun — Component Inventory (v0.1, 2026-05-09)

Повний реєстр UI-компонентів і екранів, виведений зі специфікацій модулів 1-14. Ціль: спочатку покрити фундамент → атоми → молекули → організми; екрани складатимуться з готових елементів.

---

## 0. Foundation (design tokens)

| Token group | Items |
|---|---|
| **Type scale** | display / h1 / h2 / h3 / body-lg / body / caption / micro / mono |
| **Font families** | display (serif/grotesque per chosen vibe) + body (sans) + mono (для money/IDs) |
| **Color** | bg-canvas / bg-surface / bg-elevated / fg-primary / fg-muted / fg-inverse / accent / accent-muted / success / warning / danger / info / border / overlay |
| **Spacing** | 4px grid: 0/2/4/6/8/12/16/20/24/32/40/56/72/96 |
| **Radii** | 0 / 2 / 6 / 12 / 20 / pill |
| **Shadows** | none / xs / sm / md / lg / pop |
| **Motion** | duration-fast (120ms) / base (200) / slow (320) / easing-standard / easing-emphasis |
| **Breakpoints** | mobile (≤640) / tablet (≤960) / desktop (≤1280) / wide (1281+) |
| **Z-index** | base / dropdown / sticky / overlay / modal / toast |

---

## 1. Atoms

| Component | Variants / states | Spec link |
|---|---|---|
| **Button** | primary / secondary / ghost / danger / link · sizes sm/md/lg · loading · disabled · icon-only · icon+label | універсально |
| **Icon** | 24px stroke set + 16px utility | універсально |
| **Avatar** | sizes 24/32/40/56/96 · with initials fallback · with KYC tick badge · with online dot | Auth, Reviews, Messaging |
| **Badge** | semantic (success/warning/danger/info/neutral) · pill · square · with dot | KYC, Deal state, Listing status |
| **Tag** | category tag · removable · selected · clickable | Categories, Listings |
| **Input** | text · search · password · numeric · with prefix/suffix · with clear · error/helper text | усі форми |
| **Textarea** | auto-grow · char counter · max-length warning | Listings, Disputes statement, Reviews, Messaging |
| **Select / Combobox** | single · with search · multi · with chips | Filters, Listings create |
| **Checkbox / Radio / Switch** | + grouped · + with description | Preferences, Filters |
| **Slider / Range** | price-range two-thumb | Search/Feed filters |
| **Tooltip** | hover/focus · positioning · delay | hints, KYC explanations |
| **Spinner / Skeleton** | inline + page-level skeleton (card, list, detail) | усі async surfaces |
| **Progress bar / stepper** | linear · circular · multi-step (KYC, Deal stages) | KYC, Deal lifecycle |
| **Divider** | horizontal · vertical · with label | layout |
| **Link** | inline · standalone with arrow · external | universal |
| **Kbd / Shortcut chip** | для admin tools | Admin |

---

## 2. Molecules

| Component | Notes | Spec link |
|---|---|---|
| **FormField** | label + input + helper + error · required asterisk · counter | усі форми |
| **SearchBar** | input + clear + voice (опц.) + suggest dropdown | Module 13 (Search), Feed |
| **CategoryPicker** | 3-level cascading; mobile = drill-down sheets, desktop = column tree | Module 2 (Category Tree) |
| **MoneyInput / Display** | UAH only, integer kopecks, formatter `120,00 ₴`, mono font | Deal, Payments, Wallet |
| **PriceRange** | two-thumb slider + hand-typed inputs | Search/Feed filters |
| **DateTimePicker** | due date, deadline_at, dispute window, KYC expiry | Deals, KYC, Listings |
| **FileUploader** | drag-drop · multi · ClamAV scanning state · attachment gallery cap visualizer | Module 6 (Media), Listings, KYC, Disputes, Messaging |
| **AttachmentChip** | uploading / scanning / ready / threat / error · with remove | Media flows |
| **AttachmentGallery** | grid · lightbox · order indicator · max-cap warning | Listings (1 cover + 9), Disputes (5/party) |
| **RatingStars** | display (decimal) + input (5-star, half-star toggle) | Reviews |
| **PriceDisplay** | with old/strike-through + currency badge | Listings |
| **CountBadge** | unread (`99+`), limited cap | Notifications, Messaging |
| **CopyButton** | copy ID / link | Admin, Deal share |
| **Pagination / "Load more" / Cursor** | keyset cursor — "Load more" + scroll detection | Feed, Search, Lists |
| **Breadcrumbs** | category path · admin nav | Listings, Admin |
| **Tabs** | underline / pill · scrollable on mobile | Profile, Inbox, Admin queue |
| **MenuDropdown** | row actions · with destructive variant | Listings management, Messaging |
| **EmptyState** | illustration + headline + CTA · variants per surface | усі lists |
| **ErrorState** | network error / 403 / 404 / 5xx · inline + page | universal |
| **InlineAlert / Banner** | success/warning/danger/info · dismissible · sticky variant | Deal status warnings, KYC reminders |
| **Toast / Snackbar** | bottom · stackable · with action · auto-dismiss | universal feedback |
| **Modal / Dialog** | centered · with footer actions · destructive confirm | Cancel deal, Block user, KYC submit |
| **Drawer / Sheet** | side (desktop) · bottom (mobile) | Filters, Quick actions, Conversation panel |
| **Popover** | menu / form / preview | Provider quick-view, message reactions |
| **Stepper** | KYC 4-step, Deal 5-stage horizontal | KYC, Deal |

---

## 3. Organisms (domain-specific)

### 3.1 Layout / shell

| Component | Notes |
|---|---|
| **TopNav** | logo · search · notifications · message · avatar menu · role switch (Client/Provider) · mobile hamburger |
| **SideNav (Provider/Admin)** | collapsible · grouped sections |
| **Footer** | legal (UA), language, sitemap, social |
| **MobileTabBar** | 5 entries: Feed / Search / Create / Inbox / Profile |
| **AuthShell** | split layout (form + visual side) |
| **AdminShell** | dense, mono accents, audit trail strip |

### 3.2 Listings (Module 5 + 6)

- **ListingCard** — cover, title, price, rating snippet, provider mini, KYC tick, distance/region. Variants: feed (vertical), search row (horizontal), provider-profile (compact)
- **ListingHero** — gallery + sticky price/CTA panel
- **ListingForm** — multi-step (basics → media → pricing → review)
- **ListingsManager** (provider) — table/grid with status, paused/draft/published, bulk actions
- **CategoryBreadcrumbs** — 3-level
- **MediaPipeline indicator** — uploading → scanning → ready (per-image)

### 3.3 Search & Feed (Modules 8 + 13)

- **SearchInput with Suggest** — `search_suggest_index`, recent queries
- **FilterPanel** — drawer on mobile, sticky sidebar on desktop · category, price range, region, KYC-only, rating
- **SortDropdown** — relevance / newest / price asc/desc / rating
- **ResultGrid / ResultList** — toggleable
- **FeedRail** — promoted listings, admin-curated rail
- **NoResultsState** — with suggested queries

### 3.4 Provider profile (Module 1 + Reviews + Search)

- **ProviderHeader** — avatar, display name, headline, KYC badge, location, languages, completed_deals_count, avg_rating
- **ProviderTabs** — About / Listings / Reviews / Portfolio
- **PortfolioGallery** — Module 6 media
- **ContactCTA** — pre-deal message button (gates on listings count)

### 3.5 Deal lifecycle (Module 3 + 11)

- **DealStateTracker** — visual state machine: pending → active → in_review → completed | disputed | cancelled · current state highlighted
- **DealHeader** — parties, listing snippet, agreed price, deadline
- **DealTimeline** — `deal_events` projected, PII-filtered per role
- **EscrowStatusCard** — hold/held/released/refunded · with `hold_expires_at` countdown · warning at T-24h
- **DealActionsPanel** — context-aware (Accept/Reject / Submit / Approve / Dispute / Cancel) · version-conflict UX
- **DealAttachments** — gallery
- **CancelConsentBanner** — 48h window · "other party requested" UI
- **DisputeBanner** — countdowns: 3-day response window, 14-day admin SLA
- **DisputeEvidenceForm** — reason ENUM + statement (30-4000) + 0-5 attachments · counterparty visibility hidden until response
- **DisputeEvidenceViewer** — counterparty view (with hidden state)
- **DisputeResolutionCard** — admin outcome, amounts, note (party-filtered)

### 3.6 KYC (Module 4)

- **KYCStepper** — 4 steps: documents → selfie → review → result
- **DocumentUploader** — passport / IDcard / driver's licence selectors · MRZ hint
- **LivenessSelfie** — camera capture overlay, retry · stub preview
- **KYCStatusBadge** — pending / approved / rejected / expired / re-kyc-required / suspended
- **PayoutGate** — "complete KYC to receive payouts"

### 3.7 Payments (Module 11)

- **WalletCard** — available balance, on-hold, pending payouts
- **TransactionList** — ledger projection · filter by type
- **PayoutForm** — bank/card method (LiqPay), KYC-gated
- **HoldExpiryWarning** — banner at T-24h
- **ChargebackBanner** — provider-side, mandatory, with admin link
- **RefundReceipt** — client view

### 3.8 Reviews (Module 7)

- **ReviewCard** — rating, body, attachments, reply, reported flag
- **ReviewForm** — post-completion modal · 5-star + body 100-2000 · attachments 0-3
- **ReviewReplyForm** — provider reply within 30d
- **AggregateRating** — distribution histogram + avg
- **ReportReviewSheet** — reason categories

### 3.9 Messaging (Module 10)

- **ConversationList** — last_message preview, unread count, blocked indicator, scope chip (pre-deal/deal)
- **ConversationView** — message stream + composer
- **MessageBubble** — own/other · attachments · auto-redacted indicator · gdpr-erased placeholder · admin_visible badge (admin only)
- **Composer** — textarea · attachment button · send · contact-info detection inline warning · rate-limit countdown
- **AttachmentInComposer** — preview chips, scan state
- **ContactInfoBlockBanner** — "contact info detected, send-as is or edit"
- **BlockConfirmModal** — with admin approval state for first auto-block
- **ConversationSearch** — FTS results (UA simple)
- **AdminMessageView** — for `admin_visible=TRUE` messages, with audit footer

### 3.10 Notifications (Module 9)

- **NotificationsInbox** — paginated, filter by type, mark-all-read
- **NotificationItem** — code-driven copy, deep link, mandatory marker
- **NotificationPreferences** — matrix code × channel (in-app/email/push), mandatory rows locked
- **DeviceTokenManager** — list registered devices · last_heartbeat
- **UnsubscribeLandingPage** — JWT-token one-click

### 3.11 Admin (Module 12)

- **AdminUnifiedQueue** — UNION 10 sources · keyset · severity filter
- **AdminUserDetail** — REPEATABLE READ snapshot · role-projected columns
- **DisputeResolutionWorkbench** — evidence side-by-side, conversation timeline, action panel · 4-eyes confirmation modal
- **BulkActionInitiator** — count cap 1-10, requires second admin approver
- **AdminAuditTimeline** — admin_actions feed
- **MFAChallengeModal** — 5-min single-use
- **KMSDegradedBanner** — 503 read-only mode

---

## 4. Cross-cutting flows / templates

| Flow | Components used |
|---|---|
| **Onboarding (client)** | AuthShell, FormField, Toast, KYCStepper (only if becomes provider) |
| **Onboarding (provider)** | + KYC full flow + first-listing wizard |
| **Create deal** | CategoryPicker, MoneyInput, DateTimePicker, FileUploader, ListingPicker |
| **Dispute resolution (party)** | DisputeBanner, DisputeEvidenceForm, AttachmentGallery, DisputeEvidenceViewer (after counterparty response) |
| **Dispute resolution (admin)** | DisputeResolutionWorkbench, AdminAuditTimeline |
| **GDPR erasure UX** | confirmation modal · "[видалено]" placeholders across messages/reviews/disputes |
| **Empty / error / loading sets** | EmptyState + ErrorState + Skeleton specialised per surface |

---

## 5. Page inventory (where the components compose)

### Public / unauth
1. Landing
2. Listing detail (public)
3. Provider profile (public)
4. Search results
5. Category browse

### Auth
6. Sign up (client → optional become-provider)
7. Sign in
8. Password reset / 2FA challenge
9. Email/phone verification

### Authenticated client
10. Feed (home)
11. Saved listings
12. Create deal
13. Deal detail (state-aware)
14. Deals list (mine)
15. Inbox (notifications)
16. Conversations list + view
17. Wallet / transactions
18. Reviews I wrote
19. Profile / settings
20. Notification preferences
21. GDPR data export / deletion request

### Authenticated provider (additive on top of client)
22. Provider dashboard
23. KYC flow
24. Listings manager
25. Listing create/edit
26. Payouts
27. Reviews about me
28. Provider availability / profile edit

### Disputes
29. Dispute initiation (client)
30. Dispute response (provider)
31. Dispute detail (party-filtered)

### Admin
32. Admin login + MFA
33. Unified queue
34. User detail (admin view)
35. Listings moderation
36. Reviews moderation
37. KYC review queue
38. Dispute resolution workbench
39. Categories admin (3-level CRUD + approval)
40. Notifications admin (preview, broadcast — deferred)
41. Audit log

---

## 6. Build order (recommended)

1. **Foundation tokens** (typography, color, spacing, motion)
2. **Atoms** (Button → Input → Avatar → Badge → Tag → Spinner)
3. **Layout shell** (TopNav, MobileTabBar, AuthShell)
4. **Cross-cutting molecules** (FormField, SearchBar, FileUploader, MoneyInput, CategoryPicker, AttachmentGallery, RatingStars, EmptyState, Toast, Modal)
5. **First end-to-end flow:** Listings (Card → Form → Hero → Manager) — найбільший surface, виявить прогалини
6. **Deal lifecycle** (Tracker, Header, Timeline, ActionsPanel, DisputeBanner) — найбільш складний
7. **Messaging + Notifications** (real-time-важкі)
8. **KYC + Payments** (compliance-важкі)
9. **Reviews + Search/Feed**
10. **Admin shell**

---

## Open questions before design starts

1. **Платформа:** web-only? PWA? Native mobile?
2. **Фреймворк:** React + Tailwind / vanilla HTML+CSS prototype / Vue?
3. **Темізація:** light / dark / both / auto?
4. **Mobile-first чи desktop-first** як стартова точка для першого compose?
5. **Естетичний напрямок** (editorial / industrial / Ukrainian craft / Swiss minimal — див. попереднє обговорення).

Коли визначимось з цими 5 — починаємо з foundation tokens + 5 атомів як HTML/CSS prototype або React stories.
