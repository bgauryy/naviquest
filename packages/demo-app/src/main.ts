import { createNaviquest, resolveModelContext, type NaviquestOrientation } from 'naviquest';

function need<T extends Element = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`demo markup is missing #${id}`);
  return found as unknown as T;
}

// The closed root is intentionally not registered: only the component that owns
// it can hand it to Naviquest, so coverage remains truthful.
class StatusWidget extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>.c{border:1px solid #8884;border-radius:10px;padding:12px;font:14px system-ui}.ok{color:#2f7d5d;font-weight:600}</style><div class="c"><div class="ok">All services operating normally</div><div>Last checked 4 minutes ago</div></div>`;
  }
}
customElements.define('status-widget', StatusWidget);

class InfoCard extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>.c{border:1px solid #8884;border-radius:10px;padding:12px;margin:8px 0}</style><div class="c"><slot></slot></div>`;
  }
}
customElements.define('info-card', InfoCard);

function bootHomeFixtures() {
  const list = document.getElementById('applist');
  if (!list) return;
  const applications = Array.from({ length: 520 }, (_, i) => ({
    id: 100000 + i,
    kind: ['Energy rebate', 'Bulk waste booking', 'Parking permit', 'Street light report', 'Library reservation', 'Planning comment'][i % 6],
    status: ['Approved', 'In review', 'Closed', 'Awaiting documents'][i % 4],
  }));
  const rows = document.createElement('div');
  rows.className = 'application-window';
  rows.style.height = `${applications.length * 38}px`;
  list.append(rows);
  const render = () => {
    const start = Math.max(0, Math.min(applications.length - 6, Math.floor(list.scrollTop / 38)));
    rows.style.transform = `translateY(${start * 38}px)`;
    rows.innerHTML = applications.slice(start, start + 6).map((application, index) =>
      `<div role="listitem" aria-setsize="${applications.length}" aria-posinset="${start + index + 1}"><span>#${application.id}</span><span>${application.kind}</span><span>${application.status}</span><button type="button">View ${application.id}</button></div>`).join('');
  };
  list.addEventListener('scroll', render, { passive: true });
  render();
  const dialog = document.getElementById('confirm') as HTMLDialogElement | null;
  document.getElementById('updateAddr')?.addEventListener('click', () => dialog?.showModal());
  document.getElementById('dlgCancel')?.addEventListener('click', () => dialog?.close());
  document.getElementById('dlgOk')?.addEventListener('click', () => dialog?.close());
}
bootHomeFixtures();

function bootResidentFixtures() {
  document.getElementById('parking-renew')?.addEventListener('click', () => {
    const reference = (document.getElementById('permit-ref') as HTMLInputElement | null)?.value.trim() || 'P-88421';
    const status = document.getElementById('parking-renew-status');
    if (status) status.textContent = `Renewal started for ${reference}. Pay by 1 April 2027.`;
  });
  document.getElementById('book-pc')?.addEventListener('click', () => {
    const branch = (document.getElementById('pc-branch') as HTMLSelectElement | null)?.value ?? 'Riverside';
    const when = (document.getElementById('pc-when') as HTMLSelectElement | null)?.value ?? 'the next slot';
    const status = document.getElementById('pc-book-status');
    if (status) status.textContent = `PC booked at ${branch} for ${when}. Bring your library card.`;
  });
  document.getElementById('subscribe-notices')?.addEventListener('click', () => {
    const email = (document.getElementById('notice-email') as HTMLInputElement | null)?.value.trim();
    const status = document.getElementById('notice-sub-status');
    if (status) status.textContent = email ? `Subscribed ${email} for city notices.` : 'Please give an email address before subscribing.';
  });
  const workspaceStatus = (message: string) => {
    const status = document.getElementById('workspace-action-status') ?? document.getElementById('workspace-household-status');
    if (status) status.textContent = message;
  };
  document.getElementById('workspace-remind')?.addEventListener('click', () => {
    const status = document.getElementById('workspace-remind-status');
    if (status) status.textContent = 'Reminder set for tomorrow at 09:00.';
  });
  document.getElementById('workspace-filter')?.addEventListener('click', () => workspaceStatus('Showing the three items that still need attention.'));
  document.getElementById('workspace-export')?.addEventListener('click', () => workspaceStatus('A concise account summary is ready to copy from this page.'));
  document.getElementById('workspace-address')?.addEventListener('click', () => workspaceStatus('Address review opened in this fictional workspace; no details were changed.'));
  document.getElementById('workspace-preferences')?.addEventListener('click', () => workspaceStatus('Contact preferences are shown for review; no messages were sent.'));
  document.getElementById('claim-submit')?.addEventListener('click', () => {
    const name = need<HTMLInputElement>('claim-name').value.trim();
    const address = need<HTMLInputElement>('claim-address').value.trim();
    const status = need('claim-status');
    status.textContent = name && address ? `Submitted for ${name} at ${address}. Reference RB-2026-4471.` : 'Please give your name and the property address before submitting.';
  });
}
bootResidentFixtures();

// Large, deterministic service directories make CityDesk behave like the kind
// of data-heavy SPA Naviquest is meant to orient within. They are rendered
// before registration, so agents see the same DOM a resident sees.
const pageDirectory = {
  '/parking.html': { title: 'Parking service directory', noun: 'parking request', route: '/parking.html#renew', action: 'Review permit route' },
  '/libraries.html': { title: 'Library service directory', noun: 'library service', route: '/libraries.html#pcs', action: 'Review library route' },
  '/notices.html': { title: 'Notice and consultation directory', noun: 'public notice', route: '/notices.html#planning', action: 'Review notice route' },
  '/workspace.html': { title: 'My City service history', noun: 'resident task', route: '/workspace.html#tasks', action: 'Review task route' },
} as const;
const directory = pageDirectory[location.pathname as keyof typeof pageDirectory];
if (directory) {
  const section = document.createElement('section');
  section.id = 'service-directory';
  section.setAttribute('aria-labelledby', 'service-directory-h');
  const names = ['Address update', 'Eligibility check', 'Document review', 'Appointment request', 'Payment reminder', 'Status update', 'Neighbourhood enquiry', 'Accessibility support'];
  const areas = ['Riverside', 'Northgate', 'Eastfield', 'Hillcrest', 'Parkside', 'Quayside', 'Market', 'Hospital'];
  const rows = Array.from({ length: 650 }, (_, i) => {
    const id = String(i + 1).padStart(4, '0');
    const name = names[i % names.length];
    const area = areas[i % areas.length];
    const state = i % 9 === 0 ? 'Needs attention' : i % 4 === 0 ? 'Scheduled' : 'Available';
    return `<tr><td>${directory.noun} ${id}</td><td>${name}</td><td>${area}</td><td>${state}</td><td><a href="${directory.route}">${directory.action}</a></td></tr>`;
  }).join('');
  section.innerHTML = `<h2 id="service-directory-h">${directory.title}</h2><p>Directory of 650 fictional records. Use filters or a targeted route when a specific record matters; the table is intentionally large for orientation and pagination testing.</p><div class="action-row"><button type="button">Filter by status</button><button type="button" class="secondary">Export visible records</button></div><table class="data"><thead><tr><th>Reference</th><th>Service</th><th>Area</th><th>Status</th><th>Next action</th></tr></thead><tbody>${rows}</tbody></table>`;
  document.querySelector('main')?.append(section);
}

// First-party hints complement the live page model. Keep each selector on the
// route where it exists: authored.tasks is intentionally capped and stale
// selectors are omitted by the SDK before an agent can act on them.
const pageOrientation: Record<string, NaviquestOrientation> = {
  '/': {
    purpose: 'CityDesk home brings together resident services, eligibility guidance, and routes to parking, libraries, public notices, and a private workspace.',
    tasks: [
      { name: 'Start or continue a home energy rebate application', locate: '#startReturn', how: 'Opens the rebate application journey.' },
      { name: 'Submit the rebate form after a human reviews it', locate: '#claim-submit', how: 'The form asks for resident and property details.' },
      { name: 'Report a broken street light', locate: '#report-light', how: 'Starts the street-light reporting path.' },
    ],
    constraints: ['Do not infer eligibility or submit a form. Keep payment and personal details with the resident.'],
  },
  '/parking.html': {
    purpose: 'CityDesk parking explains permit zones, prices, renewal rules, visitor permits, enforcement, and permit-related services.',
    tasks: [
      { name: 'Renew a resident parking permit', locate: '#parking-renew', how: 'Review the permit reference and vehicle registration before the resident continues.' },
    ],
    constraints: ['Do not make a payment or renew a permit without the resident confirming the details.'],
  },
  '/libraries.html': {
    purpose: 'CityDesk libraries covers branch hours, public computers, loans, events, membership, catalogue services, and study spaces.',
    tasks: [
      { name: 'Book a public computer', locate: '#book-pc', how: 'Review the branch and time slot before the resident confirms a booking.' },
    ],
    constraints: ['Do not create a booking without the resident confirming the branch and time slot.'],
  },
  '/notices.html': {
    purpose: 'CityDesk notices publishes planning and traffic notices, consultations, licensing registers, local alerts, and guidance for public comments.',
    tasks: [
      { name: 'Subscribe to the city-notice digest', locate: '#subscribe-notices', how: 'Review the email and postcode with the resident before subscribing.' },
    ],
    constraints: ['Do not subscribe an email address or submit a public comment without the resident confirming it.'],
  },
  '/workspace.html': {
    purpose: 'My City is a resident workspace for active applications, household details, reminders, saved places, service history, and local notifications.',
    tasks: [
      { name: 'Show open resident tasks', locate: '#workspace-filter', how: 'Filters the visible task list to items needing attention.' },
      { name: 'Prepare a resident service summary', locate: '#workspace-export', how: 'Prepares a concise on-page summary.' },
    ],
    constraints: ['Treat workspace details as private. Do not change household information or preferences without the resident confirming it.'],
  },
};

const orientation: NaviquestOrientation = {
  ...(pageOrientation[location.pathname] ?? {
    purpose: 'CityDesk provides local government services and resident information.',
    tasks: [],
    constraints: ['Do not submit a form or change personal information without the resident confirming it.'],
  }),
  tasks: pageOrientation[location.pathname]?.tasks ?? [],
};

// CityDesk is a WebMCP provider. It registers Naviquest and never calls any of
// its six tools: an external agent owns invocation, tool input, and responses.
const flags = new URLSearchParams(location.search);
const denseFlag = flags.get('dense');
const useDense = denseFlag !== null && denseFlag !== '0';
const useWorker = useDense || ['1', 'true', ''].includes(flags.get('worker') ?? 'off');
const naviquest = await createNaviquest({
  root: 'main',
  exclude: ['[data-private]'],
  worker: useWorker,
  dense: useDense ? 'eager' : false,
  ...(useDense && denseFlag !== '1' ? { denseBase: denseFlag } : {}),
  orientation,
});

const modelContext = resolveModelContext();
const registration = await naviquest.register();
const provider = document.createElement('aside');
provider.id = 'wf';
provider.innerHTML = `<header><h2>CityDesk WebMCP provider <span class="tag ${registration.registered ? 'win' : ''}">${registration.registered ? 'registered' : 'browser support unavailable'}</span></h2><div class="sub">${registration.registered ? `${registration.tools?.length ?? 0} Naviquest tools on ${modelContext.via}` : registration.reason ?? 'document.modelContext is unavailable'}</div><div class="mcp-usage"><b>Agent-owned usage</b><span>Tools: ${registration.tools?.length ?? 0}</span><small>This page registers tools only. The external agent receives each response’s <code>_tokens</code> and <code>_budget</code>.</small></div></header><div class="body"><p><b>For agents:</b> read <a href="/#agent-instructions">AGENT INSTRUCTIONS</a>, then map CityDesk’s pages, inputs, actions, and coverage with the registered tools.</p><p><b>For developers:</b> enable <code>chrome://flags/#enable-webmcp-testing</code> locally, then inspect this page’s registered tools in Chrome.</p><p class="sub">The demo never calls <code>find_on_page</code>, <code>describe_app</code>, or any other Naviquest tool on its own.</p></div>`;
document.body.append(provider);

// Only documented global: closed-shadow component owners may hand in a root.
window.naviquest = naviquest;
