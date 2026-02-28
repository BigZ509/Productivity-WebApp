import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

const EMPTY_PERKS = {
  unlimited_xp: false,
  skip_cooldowns: false,
  all_themes: false,
  all_presets: false,
  dev_tools: false,
}

function normalizePerks(rawPerks) {
  const perks = rawPerks && typeof rawPerks === 'object' ? rawPerks : {}
  return {
    unlimited_xp: Boolean(perks.unlimited_xp),
    skip_cooldowns: Boolean(perks.skip_cooldowns),
    all_themes: Boolean(perks.all_themes),
    all_presets: Boolean(perks.all_presets),
    dev_tools: Boolean(perks.dev_tools),
  }
}

export function usePerks() {
  const [isLoading, setIsLoading] = useState(true)
  const [isQA, setIsQA] = useState(false)
  const [perks, setPerks] = useState(EMPTY_PERKS)
  const [error, setError] = useState(null)

  useEffect(() => {
    let isActive = true

    const reset = () => {
      setIsQA(false)
      setPerks(EMPTY_PERKS)
      setError(null)
    }

    const loadPerks = async () => {
      if (!isActive) return
      setIsLoading(true)

      if (!supabase) {
        reset()
        setIsLoading(false)
        return
      }

      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.user?.id) {
        if (!isActive) return
        reset()
        setIsLoading(false)
        return
      }

      const { data, error: queryError } = await supabase
        .from('profiles')
        .select('is_qa, perks')
        .eq('id', session.user.id)
        .maybeSingle()

      if (!isActive) return

      if (queryError) {
        reset()
        setError(queryError)
        setIsLoading(false)
        return
      }

      setIsQA(Boolean(data?.is_qa))
      setPerks(normalizePerks(data?.perks))
      setError(null)
      setIsLoading(false)
    }

    loadPerks()

    const {
      data: { subscription },
    } = supabase?.auth.onAuthStateChange(() => {
      loadPerks()
    }) || { data: { subscription: { unsubscribe: () => {} } } }

    return () => {
      isActive = false
      subscription.unsubscribe()
    }
  }, [])

  return {
    isLoading,
    isQA,
    perks,
    error,
    hasPerk: (name) => Boolean(perks?.[name]),
  }
}
