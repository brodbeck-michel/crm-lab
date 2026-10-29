import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LegacyPatientsRedirect } from './index';

/** CRMLAB-126 (D-294): `/patients[/:id]` → `/contacts[/:id]` levando query e hash. */
function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>;
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/patients" element={<LegacyPatientsRedirect />} />
        <Route path="/patients/:id" element={<LegacyPatientsRedirect />} />
        <Route path="/contacts" element={<Where />} />
        <Route path="/contacts/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('where').textContent;
}

describe('LegacyPatientsRedirect', () => {
  it('/patients/:id vai para /contacts/:id com query e hash', () => {
    expect(renderAt('/patients/abc-123?tab=lgpd#orcamentos')).toBe(
      '/contacts/abc-123?tab=lgpd#orcamentos',
    );
  });

  it('/patients vai para /contacts com a busca', () => {
    expect(renderAt('/patients?search=maria')).toBe('/contacts?search=maria');
  });
});
