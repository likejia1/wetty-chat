import { useMemo } from 'react';
import { getJwtTokenFromQuery, getStoredJwtToken } from '@/utils/jwtToken';

export function useDeviceToken(allowQuery: boolean = false): string {
  return useMemo(() => {
    if (allowQuery) {
      const queryToken = getJwtTokenFromQuery(document.location.search);
      if (queryToken) {
        return queryToken;
      }
    }

    return getStoredJwtToken();
  }, [allowQuery]);
}
