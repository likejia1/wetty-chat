import apiClient from './client';

export interface User {
  uid: number;
  username: string;
  avatar_url?: string | null;
  gender: number;
}

export const usersApi = {
  getCurrentUser: async (): Promise<User> => {
    const response = await apiClient.get<User>('/users/me');
    return response.data;
  },
};
