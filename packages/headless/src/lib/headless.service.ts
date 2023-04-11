import {
  QueryClient,
  QueryObserverOptions,
  QueryObserverResult,
  MutationObserverResult,
} from '@tanstack/query-core';
import io from 'socket.io-client';
import { ApiService, IUserPreferenceSettings, IStoreQuery } from '@novu/client';
import {
  IOrganizationEntity,
  IMessage,
  IPaginatedResponse,
} from '@novu/shared';

import { QueryService } from './query.service';
import type { ISession } from '../utils/types';
import {
  NOTIFICATIONS_QUERY_KEY,
  ORGANIZATION_QUERY_KEY,
  SESSION_QUERY_KEY,
  UNREAD_COUNT_QUERY_KEY,
  UNSEEN_COUNT_QUERY_KEY,
  USER_PREFERENCES_QUERY_KEY,
} from '../utils';
import {
  FetchResult,
  IFeedId,
  IHeadlessServiceOptions,
  IMessageId,
  IUpdateActionVariables,
  IUpdateUserPreferencesVariables,
  UpdateResult,
} from './types';

export const NOTIFICATION_CENTER_TOKEN_KEY = 'nc_token';
const isBrowser = typeof window !== 'undefined';
const SESSION_NOT_INITIALIZED_ERROR =
  'Session is not initialized, please use the initializeSession method first';

const getToken = (): string | null => {
  if (isBrowser) {
    return localStorage.getItem(NOTIFICATION_CENTER_TOKEN_KEY);
  }

  return null;
};

export class HeadlessService {
  private api: ApiService;
  private queryClient: QueryClient = null;
  private queryService: QueryService;
  private socket: {
    on: (event: string, listener: (data?: unknown) => void) => void;
    off: (event: string) => void;
    disconnect: () => void;
  } | null = null;
  private session: ISession | null = null;
  private sessionQueryOptions: QueryObserverOptions<ISession, unknown> = {
    queryKey: SESSION_QUERY_KEY,
    cacheTime: Infinity,
    staleTime: Infinity,
    queryFn: () =>
      this.api.initializeSession(
        this.options.applicationIdentifier,
        this.options.subscriberId,
        this.options.subscriberHash
      ),
  };
  private organizationQueryOptions: QueryObserverOptions<
    IOrganizationEntity,
    unknown
  > = {
    queryKey: ORGANIZATION_QUERY_KEY,
    cacheTime: Infinity,
    staleTime: Infinity,
    queryFn: () => this.api.getOrganization(),
  };
  private unseenCountQueryOptions: QueryObserverOptions<
    { count: number },
    unknown
  > = {
    queryKey: UNSEEN_COUNT_QUERY_KEY,
    queryFn: () => this.api.getUnseenCount(),
  };
  private unreadCountQueryOptions: QueryObserverOptions<
    { count: number },
    unknown
  > = {
    queryKey: UNREAD_COUNT_QUERY_KEY,
    queryFn: () => this.api.getUnreadCount(),
  };
  private userPreferencesQueryOptions: QueryObserverOptions<
    IUserPreferenceSettings[],
    unknown
  > = {
    queryKey: USER_PREFERENCES_QUERY_KEY,
    queryFn: () => this.api.getUserPreference(),
  };

  constructor(private options: IHeadlessServiceOptions) {
    const backendUrl = options.backendUrl ?? 'https://api.novu.co';
    const token = getToken();
    this.api = new ApiService(backendUrl);
    this.applyToken(token);

    this.queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          retry: options?.config?.retry ?? 3,
          ...(options?.config?.retryDelay && {
            retryDelay: options?.config?.retryDelay,
          }),
        },
        mutations: {
          retry: options?.config?.retry ?? 3,
          ...(options?.config?.retryDelay && {
            retryDelay: options?.config?.retryDelay,
          }),
        },
      },
    });
    this.queryService = new QueryService(this.queryClient);
  }

  private assertSessionInitialized() {
    if (!this.session) {
      throw new Error(SESSION_NOT_INITIALIZED_ERROR);
    }
  }

  private applyToken(newToken: string | null) {
    if (newToken) {
      isBrowser &&
        localStorage.setItem(NOTIFICATION_CENTER_TOKEN_KEY, newToken);
      this.api.setAuthorizationToken(newToken);
    } else {
      isBrowser && localStorage.removeItem(NOTIFICATION_CENTER_TOKEN_KEY);
      this.api.disposeAuthorizationToken();
    }
  }

  private initializeSocket(token: string | null) {
    const socketUrl = this.options.socketUrl ?? 'https://ws.novu.co';

    if (this.socket) {
      this.socket.disconnect();
    }

    if (token) {
      this.socket = io(socketUrl, {
        reconnectionDelayMax: 10000,
        transports: ['websocket'],
        query: {
          token: `${token}`,
        },
      });

      this.socket.on('connect_error', (error: Error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }
  }

  private callFetchListener = <T>(
    result: QueryObserverResult<T>,
    listener: (result: FetchResult<T>) => void
  ) =>
    listener({
      data: result.data,
      error: result.error,
      status: result.status,
      isLoading: result.isLoading,
      isFetching: result.isFetching,
      isError: result.isError,
    });

  private callFetchListenerWithPagination = <T>(
    result: QueryObserverResult<IPaginatedResponse<T>>,
    listener: (result: FetchResult<IPaginatedResponse<T>>) => void
  ) =>
    listener({
      data: result.data,
      error: result.error,
      status: result.status,
      isLoading: result.isLoading,
      isFetching: result.isFetching,
      isError: result.isError,
    });

  private callUpdateListener = <
    TData = unknown,
    TError = unknown,
    TVariables = unknown
  >(
    result: MutationObserverResult<TData, TError, TVariables>,
    listener: (result: UpdateResult<TData, TError, TVariables>) => void
  ) =>
    listener({
      data: result.data,
      error: result.error,
      status: result.status,
      isLoading: result.isLoading,
      isError: result.isError,
    });

  public initializeSession({
    listener,
    onSuccess,
    onError,
  }: {
    listener: (result: FetchResult<ISession>) => void;
    onSuccess?: (session: ISession) => void;
    onError?: (error: unknown) => void;
  }) {
    this.session = null;
    this.queryClient.clear();

    const { unsubscribe } = this.queryService.subscribeQuery({
      options: {
        ...this.sessionQueryOptions,
        onSuccess: (session) => {
          this.session = session;
          this.applyToken(session.token);
          this.initializeSocket(session.token);
          onSuccess?.(session);
        },
        onError,
      },
      listener: (result) => this.callFetchListener(result, listener),
    });

    return unsubscribe;
  }

  public async fetchOrganization({
    listener,
    onSuccess,
    onError,
  }: {
    listener: (result: FetchResult<IOrganizationEntity>) => void;
    onSuccess?: (session: IOrganizationEntity) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { unsubscribe } = this.queryService.subscribeQuery({
      options: {
        ...this.organizationQueryOptions,
        onSuccess,
        onError,
      },
      listener: (result) => this.callFetchListener(result, listener),
    });

    return unsubscribe;
  }

  public fetchUnseenCount({
    listener,
    onSuccess,
    onError,
  }: {
    listener: (result: FetchResult<{ count: number }>) => void;
    onSuccess?: (data: { count: number }) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { unsubscribe } = this.queryService.subscribeQuery({
      options: {
        ...this.unseenCountQueryOptions,
        onSuccess,
        onError,
      },
      listener: (result) => this.callFetchListener(result, listener),
    });

    return unsubscribe;
  }

  public fetchUnreadCount({
    listener,
    onSuccess,
    onError,
  }: {
    listener: (result: FetchResult<{ count: number }>) => void;
    onSuccess?: (data: { count: number }) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { unsubscribe } = this.queryService.subscribeQuery({
      options: {
        ...this.unreadCountQueryOptions,
        onSuccess,
        onError,
      },
      listener: (result) => this.callFetchListener(result, listener),
    });

    return unsubscribe;
  }

  public listenUnseenCountChange({
    listener,
  }: {
    listener: (unseenCount: number) => void;
  }) {
    this.assertSessionInitialized();

    if (this.socket) {
      this.socket.on(
        'unseen_count_changed',
        (data?: { unseenCount: number }) => {
          if (Number.isInteger(data?.unseenCount)) {
            this.queryClient.removeQueries(NOTIFICATIONS_QUERY_KEY, {
              exact: false,
            });
            this.queryClient.setQueryData<{ count: number }>(
              UNSEEN_COUNT_QUERY_KEY,
              (oldData) => ({ count: data?.unseenCount ?? oldData.count })
            );
            listener(data.unseenCount);
          }
        }
      );
    }

    return () => {
      if (this.socket) {
        this.socket.off('unseen_count_changed');
      }
    };
  }

  public fetchNotifications({
    page = 0,
    storeId = 'default_store',
    query = {},
    listener,
    onSuccess,
    onError,
  }: {
    page?: number;
    storeId?: string;
    query?: IStoreQuery;
    listener: (result: FetchResult<IPaginatedResponse<IMessage>>) => void;
    onSuccess?: (messages: IPaginatedResponse<IMessage>) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { unsubscribe } = this.queryService.subscribeQuery({
      options: {
        queryKey: [...NOTIFICATIONS_QUERY_KEY, storeId, page, query],
        queryFn: () => this.api.getNotificationsList(page, query),
        onSuccess,
        onError,
      },
      listener: (result) =>
        this.callFetchListenerWithPagination(result, listener),
    });

    return unsubscribe;
  }

  public fetchUserPreferences({
    listener,
    onSuccess,
    onError,
  }: {
    listener: (result: FetchResult<IUserPreferenceSettings[]>) => void;
    onSuccess?: (settings: IUserPreferenceSettings[]) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { unsubscribe } = this.queryService.subscribeQuery({
      options: {
        ...this.userPreferencesQueryOptions,
        onSuccess,
        onError,
      },
      listener: (result) => this.callFetchListener(result, listener),
    });

    return unsubscribe;
  }

  public async updateUserPreferences({
    templateId,
    channelType,
    checked,
    listener,
    onSuccess,
    onError,
  }: {
    templateId: IUpdateUserPreferencesVariables['templateId'];
    channelType: IUpdateUserPreferencesVariables['channelType'];
    checked: IUpdateUserPreferencesVariables['checked'];
    listener: (
      result: UpdateResult<
        IUserPreferenceSettings,
        unknown,
        IUpdateUserPreferencesVariables
      >
    ) => void;
    onSuccess?: (settings: IUserPreferenceSettings) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { result, unsubscribe } = this.queryService.subscribeMutation<
      IUserPreferenceSettings,
      unknown,
      IUpdateUserPreferencesVariables
    >({
      options: {
        mutationFn: (variables) =>
          this.api.updateSubscriberPreference(
            variables.templateId,
            variables.channelType,
            variables.checked
          ),
        onSuccess: (data) => {
          this.queryClient.setQueryData<IUserPreferenceSettings[]>(
            USER_PREFERENCES_QUERY_KEY,
            (oldUserPreferences) =>
              oldUserPreferences.map((setting) => {
                if (setting.template._id === data.template._id) {
                  return data;
                }

                return setting;
              })
          );
        },
      },
      listener: (res) => this.callUpdateListener(res, listener),
    });

    result
      .mutate({ templateId, channelType, checked })
      .then((data) => {
        onSuccess?.(data);

        return data;
      })
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        unsubscribe();
      });
  }

  public async markNotificationsAsRead({
    messageId,
    listener,
    onSuccess,
    onError,
  }: {
    messageId: IMessageId;
    listener: (
      result: UpdateResult<IMessage, unknown, { messageId: IMessageId }>
    ) => void;
    onSuccess?: (message: IMessage) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { result, unsubscribe } = this.queryService.subscribeMutation<
      IMessage,
      unknown,
      { messageId: IMessageId }
    >({
      options: {
        mutationFn: (variables) =>
          this.api.markMessageAs(variables.messageId, {
            seen: true,
            read: true,
          }),
        onSuccess: (data) => {
          this.queryClient.setQueriesData<IMessage[]>(
            { queryKey: NOTIFICATIONS_QUERY_KEY, exact: false },
            (oldMessages) =>
              oldMessages.map((message) => {
                if (message._id === data._id) {
                  return data;
                }

                return message;
              })
          );
        },
      },
      listener: (res) => this.callUpdateListener(res, listener),
    });

    result
      .mutate({ messageId })
      .then((data) => {
        onSuccess?.(data);

        return data;
      })
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        unsubscribe();
      });
  }

  public async removeNotification({
    messageId,
    listener,
    onSuccess,
    onError,
  }: {
    messageId: string;
    listener: (
      result: UpdateResult<IMessage, unknown, { messageId: string }>
    ) => void;
    onSuccess?: (message: IMessage) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { result, unsubscribe } = this.queryService.subscribeMutation<
      IMessage,
      unknown,
      { messageId: string }
    >({
      options: {
        mutationFn: (variables) => this.api.removeMessage(variables.messageId),
        onSuccess: (data) => {
          this.queryClient.removeQueries(NOTIFICATIONS_QUERY_KEY, {
            exact: false,
          });
        },
      },
      listener: (res) => this.callUpdateListener(res, listener),
    });

    result
      .mutate({ messageId })
      .then((data) => {
        onSuccess?.(data);

        return data;
      })
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        unsubscribe();
      });
  }

  public async updateAction({
    messageId,
    actionButtonType,
    status,
    payload,
    listener,
    onSuccess,
    onError,
  }: {
    messageId: IUpdateActionVariables['messageId'];
    actionButtonType: IUpdateActionVariables['actionButtonType'];
    status: IUpdateActionVariables['status'];
    payload?: IUpdateActionVariables['payload'];
    listener: (
      result: UpdateResult<IMessage, unknown, IUpdateActionVariables>
    ) => void;
    onSuccess?: (data: IMessage) => void;
    onError?: (error: unknown) => void;
  }) {
    this.assertSessionInitialized();

    const { result, unsubscribe } = this.queryService.subscribeMutation<
      IMessage,
      unknown,
      IUpdateActionVariables
    >({
      options: {
        mutationFn: (variables) =>
          this.api.updateAction(
            variables.messageId,
            variables.actionButtonType,
            variables.status,
            variables.payload
          ),
        onSuccess: (data) => {
          this.queryClient.setQueriesData<IMessage[]>(
            { queryKey: NOTIFICATIONS_QUERY_KEY, exact: false },
            (oldMessages) =>
              oldMessages.map((message) => {
                if (message._id === messageId) {
                  return data;
                }

                return message;
              })
          );
        },
      },
      listener: (res) => this.callUpdateListener(res, listener),
    });

    result
      .mutate({ messageId, actionButtonType, status, payload })
      .then((data) => {
        onSuccess?.(data);

        return data;
      })
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        unsubscribe();
      });
  }

  public async markAllMessagesAsRead({
    listener,
    onSuccess,
    onError,
    feedId,
  }: {
    listener: (result: UpdateResult<number, unknown, undefined>) => void;
    onSuccess?: (count: number) => void;
    onError?: (error: unknown) => void;
    feedId?: IFeedId;
  }) {
    this.assertSessionInitialized();

    const { result, unsubscribe } = this.queryService.subscribeMutation<
      number,
      unknown,
      { feedId?: IFeedId }
    >({
      options: {
        mutationFn: (variables) =>
          this.api.markAllMessagesAsRead(variables?.feedId),
        onSuccess: (data) => {
          this.queryClient.refetchQueries(NOTIFICATIONS_QUERY_KEY, {
            exact: false,
          });
        },
      },
      listener: (res) => this.callUpdateListener(res, listener),
    });

    result
      .mutate({ feedId })
      .then((data) => {
        onSuccess?.(data);

        return data;
      })
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        unsubscribe();
      });
  }

  public async markAllMessagesAsSeen({
    listener,
    onSuccess,
    onError,
    feedId,
  }: {
    listener: (result: UpdateResult<number, unknown, undefined>) => void;
    onSuccess?: (count: number) => void;
    onError?: (error: unknown) => void;
    feedId?: IFeedId;
  }) {
    this.assertSessionInitialized();

    const { result, unsubscribe } = this.queryService.subscribeMutation<
      number,
      unknown,
      { feedId?: IFeedId }
    >({
      options: {
        mutationFn: (variables) =>
          this.api.markAllMessagesAsSeen(variables?.feedId),
        onSuccess: (data) => {
          this.queryClient.refetchQueries(NOTIFICATIONS_QUERY_KEY, {
            exact: false,
          });
        },
      },
      listener: (res) => this.callUpdateListener(res, listener),
    });

    result
      .mutate({ feedId })
      .then((data) => {
        onSuccess?.(data);

        return data;
      })
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        unsubscribe();
      });
  }
}
