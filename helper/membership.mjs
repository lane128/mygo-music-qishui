// Official PC client: account badges use commerce.membership; comment badges
// use user.vip_stage. These labels are presentation only, never playback grants.
export const COMMERCE_PATH = '/luna/pc/commerce/v2/commerce_info'

export function vipTier(stage) {
  if (stage === 'svip') return 'SVIP'
  if (stage === 'vip' || stage === 'free_vip') return 'VIP'
  return ''
}

export function memberName(name, tier) {
  return tier ? `${tier} · ${name}` : name
}

export function accountTier(profile, commerce, now = Date.now() / 1000) {
  const m = commerce?.membership
  if (typeof m?.is_membership === 'boolean') {
    if (!m.is_membership) return ''
    // An explicitly expired or malformed expiry cannot establish membership.
    if (m.expire_time != null && (!Number.isSafeInteger(m.expire_time) || m.expire_time < 0 || m.expire_time > 0 && m.expire_time <= now)) return ''
    return vipTier(m.membership_type)
  }
  return profile?.is_vip === true ? vipTier(profile.vip_stage) : ''
}

export function commentTier(user) {
  // Public briefs may omit is_vip: the official comment badge uses vip_stage.
  // Respect an explicit non-member flag rather than displaying a stale stage.
  if (user?.is_vip != null && user.is_vip !== true) return ''
  return vipTier(user?.vip_stage)
}
