const PLANS = [
  { name: 'Free', price: '$0/month', detail: 'Hard limit; free-model access only' },
  { name: 'Starter', price: '$5/month', detail: 'Entry paid plan' },
  { name: 'Pro', price: '$7/month', detail: 'Higher paid-plan allowance' },
  { name: 'Max', price: '$10/month', detail: 'Highest Hesdor plan' },
] as const

/** Display the public Hesdor Cloud plan catalog. Quotas are enforced by the service. */
export function runPricing(): number {
  console.log('Hesdor Cloud plans\n')
  for (const plan of PLANS) console.log(`  ${plan.name.padEnd(8)} ${plan.price.padEnd(12)} ${plan.detail}`)
  console.log('\nUse `hesdor setup` to configure HESDOR_API_KEY.')
  console.log('Use HESDOR_BASE_URL when the Hesdor API is not using its default endpoint.')
  console.log('Billing and account quotas are enforced by the Hesdor API service.')
  return 0
}
