import { Page, expect } from '@playwright/test';
import {
  E2E_USERS,
  E2E_PASSWORD,
  E2E_TENANTS,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_PROPOSALS,
  type E2eUser,
} from '../../backend/src/db/seeds/e2e-fixtures.js';

/**
 * Login with the given user and verify we land on the expected page.
 */
export async function loginAs(page: Page, user: E2eUser) {
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', E2E_PASSWORD);
  await page.click('button:has-text("Entrar")');

  // Wait for redirect (either to /attendance, /proposals, or /platform/tenants based on role)
  await expect(page).toHaveURL(/(attendance|proposals|platform\/tenants)/, {
    timeout: 5000,
  });
}

/**
 * Navigate to the new budget page for the given conversation.
 */
export async function openNewBudgetPage(page: Page, conversationId: string) {
  await page.goto(`/budget/new?conversationId=${conversationId}`);
  // Wait for the page to load and show the exam catalog
  await expect(page.locator('text=Catálogo') || page.locator('text=Exames')).toBeVisible({
    timeout: 5000,
  });
}

/**
 * Add an exam to the budget by searching and clicking add.
 */
export async function addExamToBudget(page: Page, examName: string) {
  // Find and click the exam in the catalog
  const examLocator = page.locator(`text=${examName}`).first();
  await expect(examLocator).toBeVisible({ timeout: 5000 });
  await examLocator.click();

  // Wait for the exam to appear in the summary (right column)
  await expect(
    page.locator(`text="${examName}"`, { hasText: examName }).nth(1), // second occurrence in summary
  ).toBeVisible({ timeout: 3000 });
}

/**
 * Set the discount percentage in the budget.
 */
export async function setDiscount(page: Page, percentValue: number) {
  const discountInput = page.locator('input[type="number"]').or(page.locator('input[type="range"]')).first();
  await discountInput.fill(String(percentValue));
  // Wait for total to recalculate
  await page.waitForTimeout(300);
}

/**
 * Get the total from the budget summary.
 */
export async function getTotalPrice(page: Page): Promise<number> {
  const totalText = await page.locator('text=/Total:|R\\$ /').last().textContent();
  const match = totalText?.match(/[\d.,]+/);
  return match ? parseFloat(match[0].replace('.', '').replace(',', '.')) : 0;
}

/**
 * Create the proposal by clicking the create button.
 */
export async function createProposal(page: Page): Promise<string | null> {
  await page.click('button:has-text("Criar"), button:has-text("Enviar")');

  // Wait for the proposal to be created and navigate to the conversation or success page
  try {
    await expect(page).toHaveURL(new RegExp(/\/attendance|\/proposals/), { timeout: 5000 });
    return null; // Navigation successful
  } catch {
    // Try to extract proposal ID from error message or response
    const response = await page.waitForResponse(
      (res) => res.url().includes('/proposals') && res.status() === 201,
      { timeout: 3000 },
    );
    const data = await response.json();
    return data.id || null;
  }
}

/**
 * Mark a proposal as sent (orcamento_enviado).
 */
export async function markProposalAsSent(page: Page, proposalId: string) {
  // Navigate to the proposal or open it via modal
  await page.goto(`/attendance`); // Navigate to attendance first
  // Find the proposal card and click it
  await expect(page.locator(`text="${proposalId}"`)).toBeVisible({ timeout: 5000 });
  await page.locator(`text="${proposalId}"`).click();

  // Click "Enviar" or similar button in the modal/detail view
  const sendButton = page.locator('button:has-text("Enviar")').nth(0);
  await expect(sendButton).toBeVisible({ timeout: 3000 });
  await sendButton.click();

  // Wait for success
  await expect(page.locator('text=enviado')).toBeVisible({ timeout: 5000 });
}

/**
 * Wait for a system message to appear in the conversation.
 */
export async function expectSystemMessage(page: Page, messageText: string) {
  const messageLocator = page.locator(`text="${messageText}"`);
  await expect(messageLocator).toBeVisible({ timeout: 5000 });
}

export { E2E_USERS, E2E_PASSWORD, E2E_TENANTS, E2E_CONVERSATIONS, E2E_EXAMS, E2E_PROPOSALS };
