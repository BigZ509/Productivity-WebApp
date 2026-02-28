import { supabase } from './lib/supabaseClient'

export async function debugSupabase() {
  console.log('🧪 SUPABASE DEBUG START')

  try {
    // SESSION
    const { data: sessionData } = await supabase.auth.getSession()
    console.log('SESSION:', sessionData?.session ? '✅ logged in' : '❌ no session')

    if (!sessionData?.session) return

    const userId = sessionData.session.user.id

    // PROFILE
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    console.log('PROFILE:', profile)
    if (profileErr) console.error('PROFILE ERROR:', profileErr)

    // QUESTS SAMPLE
    const { data: quests, error: questsErr } = await supabase
      .from('quests')
      .select('*')
      .limit(3)

    console.log('QUESTS SAMPLE:', quests)
    if (questsErr) console.error('QUESTS ERROR:', questsErr)

    // USER ACTIVE QUESTS SAMPLE
    const { data: active, error: activeErr } = await supabase
      .from('user_active_quests')
      .select('*')
      .limit(3)

    console.log('ACTIVE QUESTS SAMPLE:', active)
    if (activeErr) console.error('ACTIVE QUESTS ERROR:', activeErr)

    // PATH MATCH CHECK
    if (profile?.path) {
      const { data: pathMatches } = await supabase
        .from('quests')
        .select('id')
        .eq('path', profile.path)
        .limit(1)

      console.log(
        'PATH MATCH:',
        pathMatches?.length ? '✅ quests exist for path' : '❌ NO quests for this path',
      )
    }

    // GROUP MEMBERSHIP
    const { data: membership } = await supabase
      .from('group_members')
      .select('*')
      .eq('user_id', userId)
      .limit(1)

    console.log(
      'GROUP MEMBERSHIP:',
      membership?.length ? '✅ in group' : '❌ not in any group',
    )

    // LEADERBOARD VISIBILITY CHECK
    const { data: leaderboardTest, error: lbErr } = await supabase
      .from('profiles')
      .select('id')
      .limit(1)

    console.log(
      'RLS READ TEST (profiles):',
      leaderboardTest ? '✅ allowed' : '❌ blocked',
    )
    if (lbErr) console.error('RLS ERROR:', lbErr)

    console.log('🧪 DEBUG COMPLETE')
  } catch (err) {
    console.error('DEBUG FAILED:', err)
  }
}
