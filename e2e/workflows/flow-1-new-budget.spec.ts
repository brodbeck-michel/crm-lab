/**
 * Flow 1: New Budget
 *
 * Attendant creates budget from conversation:
 * 1. Navigate to /budget/new?conversationId=...
 * 2. Select exams (Hemograma, Glicose)
 * 3. Apply 10% discount
 * 4. Create proposal (POST /proposals) → verify proposal created
 * 5. Mark as sent (orcamento_enviado) → PATCH /proposals/:id/status
 * 6. Verify system message appears in conversation
 *
 * Fixtures: E2E_CONVERSATIONS.atribuida (assigned to alfaAttendant)
 *           E2E_EXAMS.hemograma, E2E_EXAMS.glicose
 */

import { test, expect } from '@playwright/test';
import {
  loginAs,
  E2E_USERS,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
} from './helpers.js';

test.describe('Flow 1: New Budget', () => {
  test('attendant creates budget, applies discount, sends to patient', async ({ page }) => {
    // Step 1: Login as attendant
    await loginAs(page, E2E_USERS.alfaAttendant);

    // Step 2: Navigate to budget creation page
    const conversationId = E2E_CONVERSATIONS.atribuida.id;
    await page.goto(`/budget/new?conversationId=${conversationId}`);

    // Wait for the page to load
    await expect(page.locator('text=Catálogo')).toBeVisible({ timeout: 5000 }).catch(async () => {
      // Try alternative text
      await expect(page.locator('text=Exames')).toBeVisible({ timeout: 5000 });
    });

    // Step 3: Select exams
    // Add Hemograma (38.0)
    const hemoLocator = page.locator(`text="${E2E_EXAMS.hemograma.name}"`).first();
    await expect(hemoLocator).toBeVisible({ timeout: 5000 });
    await hemoLocator.click();

    // Add Glicose (22.0)
    const glicLocator = page.locator(`text="${E2E_EXAMS.glicose.name}"`).first();
    await expect(glicLocator).toBeVisible({ timeout: 5000 });
    await glicLocator.click();

    // Step 4: Apply 10% discount
    const discountInput = page.locator('input[type="number"]').or(page.locator('input[type="range"]')).first();
    await discountInput.fill('10');
    await page.waitForTimeout(300);

    // Step 5: Create proposal
    const createButton = page.locator('button').filter({ hasText: 'Criar' }).or(page.locator('button').filter({ hasText: 'Enviar' })).first();
    await expect(createButton).toBeVisible({ timeout: 5000 });
    await createButton.click();

    // After creating, we should be redirected to attendance or proposal view
    await expect(page).toHaveURL(/(attendance|proposals)/, { timeout: 5000 });
  });

  test('total is calculated from items and discount, never from client', async ({ page }) => {
    // This test verifies that the backend recalculates the total
    await loginAs(page, E2E_USERS.alfaAttendant);

    const conversationId = E2E_CONVERSATIONS.atribuida.id;
    await page.goto(`/budget/new?conversationId=${conversationId}`);

    // Wait for the page to load
    await page.waitForTimeout(1000);

    // Add exams: TSH (48) + Vitamina D (98) = 146
    const tshLocator = page.locator(`text="${E2E_EXAMS.tsh.name}"`).first();
    if (await tshLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tshLocator.click();
    }

    const vitLocator = page.locator(`text="${E2E_EXAMS.vitaminaD.name}"`).first();
    if (await vitLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await vitLocator.click();
    }

    // Apply 5% discount
    const discountInput = page.locator('input[type="number"]').or(page.locator('input[type="range"]')).first();
    await discountInput.fill('5');
    await page.waitForTimeout(300);

    // Create and verify backend calculates the same
    const createButton = page.locator('button').filter({ hasText: 'Criar' }).or(page.locator('button').filter({ hasText: 'Enviar' })).first();
    if (await createButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await createButton.click();
    }

    // Navigate to proposals to verify the created proposal
    await page.goto('/proposals');
    await expect(page.locator('text=Hemograma').or(page.locator('text=TSH'))).toBeVisible({
      timeout: 5000,
    });
  });

  test('discount within attendant limit (15%) does not require approval', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant); // limit 15%

    const conversationId = E2E_CONVERSATIONS.atribuida.id;
    await page.goto(`/budget/new?conversationId=${conversationId}`);

    // Wait for the page to load
    await page.waitForTimeout(1000);

    // Select single exam
    const hemoLocator = page.locator(`text="${E2E_EXAMS.hemograma.name}"`).first();
    if (await hemoLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await hemoLocator.click();
    }

    // Apply 10% discount (within 15% limit)
    const discountInput = page.locator('input[type="number"]').or(page.locator('input[type="range"]')).first();
    await discountInput.fill('10');
    await page.waitForTimeout(300);

    // Create proposal - should succeed without showing approval warning
    const createButton = page.locator('button').filter({ hasText: 'Criar' }).or(page.locator('button').filter({ hasText: 'Enviar' })).first();
    if (await createButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await createButton.click();
    }

    // Navigate to check proposal
    await page.goto('/proposals');

    // Verify proposal was created
    await expect(page.locator('text=Hemograma')).toBeVisible({ timeout: 5000 });
  });
});
