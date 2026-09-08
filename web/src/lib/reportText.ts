import { statusLabel, type LineRecord, type SiteReport } from '@sw/shared';

/**
 * Renders a site report as plain text for pasting into a ticket or an email.
 *
 * Deliberately plain: no box drawing, no colour, no markdown. It has to
 * survive being pasted into a helpdesk that strips formatting, an Outlook
 * reply and an SMS, so it uses nothing but spaces, hyphens and line breaks.
 */

const rule = (char = '-'): string => char.repeat(58);

const line = (label: string, value?: string | number | boolean | null): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  // Pad labels so values line up without tabs, which paste unpredictably.
  return `${`${label}:`.padEnd(22)}${text}`;
};

const block = (title: string, rows: Array<string | null>): string[] => {
  const kept = rows.filter((r): r is string => r !== null);
  if (!kept.length) return [];
  return ['', title.toUpperCase(), rule(), ...kept];
};

const mbps = (v?: number): string | undefined =>
  v == null ? undefined : v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} Gbps` : `${v} Mbps`;

const date = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString('en-GB');
};

/** One line record, rendered compactly. */
function lineSection(record: LineRecord, index: number, total: number): string[] {
  const heading = total > 1 ? `LINE ${index + 1} OF ${total}` : 'LINE';
  return block(heading, [
    line('CLI', record.cli),
    line('Access line ID', record.lineAccessId),
    line('Service ID', record.serviceId),
    line('Zen reference', record.orderRef),
    line('Status', record.status.replace(/_/g, ' ')),
    line('Technology', record.technology),
    line('Product', record.productName),
    line('Provider', record.provider),
    line(
      'Online',
      record.radius?.online === undefined ? undefined : record.radius.online ? 'Yes' : 'No — not authenticated',
    ),
    line('RADIUS username', record.radius?.username),
    record.sync?.downstreamSyncKbps != null
      ? line(
          'Sync',
          `${Math.round(record.sync.downstreamSyncKbps / 1000)} / ${Math.round((record.sync.upstreamSyncKbps ?? 0) / 1000)} Mbps`,
        )
      : null,
    record.sync?.snrMarginDb != null ? line('SNR margin', `${record.sync.snrMarginDb} dB`) : null,
    record.sync?.attenuationDb != null ? line('Attenuation', `${record.sync.attenuationDb} dB`) : null,
    line('DLM profile', record.sync?.profileName),
    line('ONT serial', record.ont?.serial),
    line('Router', record.cpe ? `${record.cpe.vendor ?? ''} ${record.cpe.model ?? ''}`.trim() : undefined),
    ...(record.ipAddresses ?? []).map((ip, i) =>
      line(
        i === 0 ? 'IP addresses' : '',
        `${ip.value}${ip.prefixLength != null ? `/${ip.prefixLength}` : ''} (${ip.assignment})`,
      ),
    ),
    line('Contract ends', date(record.contract?.endDate)),
    line('In contract', record.contract?.inContract),
    ...(record.faults ?? []).map((fault) => line('OPEN FAULT', `${fault.reference} — ${fault.summary}`)),
    ...(record.appointments ?? []).map((appt) =>
      line('APPOINTMENT', `${date(appt.date)} ${appt.slot ?? ''} — ${appt.type}`.trim()),
    ),
  ]);
}

export function siteReportToText(report: SiteReport): string {
  const { address, broadband, signal, lines } = report;
  const out: string[] = [];

  out.push('SUPPORTWIZARD NETKIT — SITE REPORT', rule('='));
  out.push(
    line('Address', address.singleLine) ?? '',
    line('UPRN', report.uprn ?? address.uprn) ?? '',
    line('Postcode', address.postcode) ?? '',
  );
  const optionalIdentity = [
    line('Premises type', address.classificationLabel ?? address.premisesType),
    line('Post town', address.postTown),
    line('Local authority', address.localAuthority),
    line('Ward', address.ward),
    line('Openreach address key', address.addressKey),
    address.latitude != null && address.longitude != null
      ? line('Coordinates', `${address.latitude}, ${address.longitude}`)
      : null,
  ].filter((l): l is string => l !== null);
  out.push(...optionalIdentity);

  // ---- Availability -------------------------------------------------
  if (broadband) {
    if (broadband.headline) {
      out.push(
        ...block('BEST AVAILABLE', [
          line('Technology', broadband.headline.technology),
          line('Operator', broadband.headline.operatorLabel),
          line('Download', mbps(broadband.headline.downMbps)),
          line('Upload', mbps(broadband.headline.upMbps)),
        ]),
      );
    }

    // Footprint-only coverage is separated out and labelled. This text gets
    // pasted into tickets and read to customers, so an unchecked alt-net must
    // never sit in a list headed "orderable".
    const sellable = broadband.offers.filter((o) => o.serviceability !== 'footprint');
    const coverageOnly = broadband.offers.filter((o) => o.serviceability === 'footprint');

    const orderable = sellable.filter((o) => o.status === 'available');
    if (orderable.length) {
      out.push('', 'ORDERABLE NOW', rule());
      for (const offer of orderable) {
        const speeds = [mbps(offer.speeds.downMbpsHigh), mbps(offer.speeds.upMbpsHigh)].filter(Boolean).join(' / ');
        out.push(
          `  - ${offer.technology.padEnd(10)} ${offer.operatorLabel}${speeds ? ` — ${speeds}` : ''}${
            offer.productName ? ` (${offer.productName})` : ''
          }`,
        );
      }
    }

    const notAvailable = sellable.filter((o) => o.status !== 'available');
    if (notAvailable.length) {
      out.push('', 'NOT CURRENTLY AVAILABLE', rule());
      for (const offer of notAvailable) {
        out.push(
          `  - ${offer.technology.padEnd(10)} ${offer.operatorLabel} — ${statusLabel(offer.status)}${
            offer.rfsDate ? ` (${date(offer.rfsDate)})` : ''
          }`,
        );
      }
    }

    if (broadband.predicted) {
      const p = broadband.predicted;
      out.push('', 'OFCOM PREDICTION (independent — names no operator)', rule());
      out.push(`  Max down:        ${mbps(p.maxDownMbps) ?? '—'}`);
      out.push(`  Max up:          ${mbps(p.maxUpMbps) ?? '—'}`);
      out.push(`  Matched:         ${p.premisesMatched ? 'this exact premises' : `postcode only (${p.premisesInPostcode ?? 0} premises)`}`);
    }

    if (coverageOnly.length) {
      out.push('', 'OTHER NETWORKS IN THE AREA — NOT CHECKED FOR THIS ADDRESS', rule());
      for (const offer of coverageOnly) {
        out.push(
          `  - ${offer.technology.padEnd(10)} ${offer.operatorLabel} — ${statusLabel(offer.status)}${
            offer.rfsDate ? ` (${date(offer.rfsDate)})` : ''
          }`,
        );
      }
      out.push('    These networks build in the area. Nobody has checked this exact address,');
      out.push('    and none are resellable through our wholesale account.');
    }

    const or = broadband.openreach;
    if (or) {
      out.push(
        ...block('OPENREACH', [
          line('Exchange', or.exchange?.name),
          line('Exchange code', or.exchange?.tlc ?? or.exchange?.code),
          line('MDF site', or.exchange?.mdfSiteId),
          line('Cabinet (PCP)', or.cabinet?.id),
          or.copper?.lineLengthMetres != null ? line('Copper loop', `${or.copper.lineLengthMetres} m`) : null,
          or.copper?.attenuationDb != null ? line('Attenuation', `${or.copper.attenuationDb} dB`) : null,
          line('SOGEA available', or.copper?.sogeaAvailable),
          line('FTTP available', or.fttp?.available),
          line('FTTP build status', or.fttp?.buildStatus),
          line('FTTP RFS date', date(or.fttp?.rfsDate)),
          line('ONT fitted', or.fttp?.ontPresent),
          line('ONT serial', or.fttp?.ontSerial),
          line('WLR stop sell', or.stopSell?.wlr),
        ]),
      );

      if (or.flags.length) {
        out.push('', 'FLAGS', rule());
        for (const flag of or.flags) {
          out.push(`  [${flag.level.toUpperCase()}] ${flag.label}`);
          if (flag.detail) {
            // Wrap the detail so it survives a narrow paste target.
            for (const chunk of wrap(flag.detail, 54)) out.push(`      ${chunk}`);
          }
        }
      }
    }
  }

  // ---- Coverage ------------------------------------------------------
  if (signal?.operators.length) {
    out.push('', 'MOBILE COVERAGE (indoor / outdoor)', rule());
    for (const operator of signal.operators) {
      out.push(
        `  ${operator.operator.padEnd(10)} voice ${operator.voice.indoor}/${operator.voice.outdoor}` +
          `   4G ${operator.data4g.indoor}/${operator.data4g.outdoor}` +
          (operator.data5g ? `   5G ${operator.data5g.indoor}/${operator.data5g.outdoor}` : '   5G none'),
      );
    }
    out.push(`  Source: ${signal.sources.join(', ')}`);
  }

  // ---- Lines ---------------------------------------------------------
  if (lines.length) {
    lines.forEach((record, i) => out.push(...lineSection(record, i, lines.length)));
  } else {
    out.push('', 'LINES', rule(), '  No lines found at this premises.');
  }

  out.push('', rule('='));
  out.push(`Generated ${new Date(report.generatedAt).toLocaleString('en-GB')} by SupportWizard NetKit`);
  out.push(`Query "${report.query.raw}" read as ${report.query.kind}`);
  const unavailable = Object.entries(report.status)
    .filter(([, s]) => s.mode === 'skipped' || !s.ok)
    .map(([name]) => name);
  if (unavailable.length) {
    out.push(`NOTE: no data for: ${unavailable.join(', ')} — the provider is not connected or did not answer.`);
  }
  out.push('SupportWizard Internal · Confidential');

  return out.filter((l) => l !== '' || true).join('\n');
}

/** Simple greedy word wrap. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && `${current} ${word}`.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
