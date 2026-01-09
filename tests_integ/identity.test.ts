/**
 * Integration tests for AgentCore Identity SDK
 * 
 * These tests require:
 * - AWS credentials configured
 * - AgentCore Identity service available in the region
 * - Permissions to create/delete identities and providers
 * 
 * For OAuth2 token tests:
 * - Set OAUTH2_PROVIDER_NAME env var to test OAuth2 M2M flow
 * - Set OAUTH2_SCOPES env var (comma-separated)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IdentityClient } from '../src/identity/client.js';
import { withAccessToken, withApiKey } from '../src/identity/index.js';
import {
  BedrockAgentCoreClient,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreateWorkloadIdentityCommand,
  GetWorkloadIdentityCommand,
  DeleteWorkloadIdentityCommand,
  CreateOauth2CredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  CreateApiKeyCredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

describe('Identity Integration Tests', () => {
  const testIdentityName = `test-identity-${Date.now()}`;
  const testOAuth2ProviderName = `test-oauth2-${Date.now()}`;
  const testApiKeyProviderName = `test-apikey-${Date.now()}`;
  let client: IdentityClient;
  let dataPlaneClient: BedrockAgentCoreClient;
  let controlPlaneClient: BedrockAgentCoreControlClient;

  beforeAll(async () => {
    const region = process.env.AWS_REGION || 'us-west-2';
    client = new IdentityClient(region);
    dataPlaneClient = new BedrockAgentCoreClient({ region });
    controlPlaneClient = new BedrockAgentCoreControlClient({ region });
  });

  afterAll(async () => {
    // Cleanup test-specific resources using AWS SDK directly
    await Promise.allSettled([
      controlPlaneClient.send(new DeleteOauth2CredentialProviderCommand({ name: testOAuth2ProviderName })),
      controlPlaneClient.send(new DeleteApiKeyCredentialProviderCommand({ name: testApiKeyProviderName })),
      controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: testIdentityName })),
    ]);
  });

  describe('Workload Identity Lifecycle', () => {
    it('creates, gets, and deletes workload identity', async () => {
      try {
        await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: testIdentityName }));
      } catch {}

      const createCommand = new CreateWorkloadIdentityCommand({
        name: testIdentityName,
        allowedResourceOauth2ReturnUrls: ['https://example.com/callback'],
      });
      const created = await controlPlaneClient.send(createCommand);
      
      expect(created).toMatchObject({
        name: testIdentityName,
        workloadIdentityArn: expect.any(String),
        allowedResourceOauth2ReturnUrls: ['https://example.com/callback'],
      });

      const getCommand = new GetWorkloadIdentityCommand({ name: testIdentityName });
      const retrieved = await controlPlaneClient.send(getCommand);
      expect(retrieved).toMatchObject({
        name: testIdentityName,
        workloadIdentityArn: created.workloadIdentityArn,
        allowedResourceOauth2ReturnUrls: ['https://example.com/callback'],
      });

      const deleteCommand = new DeleteWorkloadIdentityCommand({ name: testIdentityName });
      await controlPlaneClient.send(deleteCommand);
      
      await expect(
        controlPlaneClient.send(new GetWorkloadIdentityCommand({ name: testIdentityName }))
      ).rejects.toThrow();
    }, 30000);
  });

  describe('OAuth2 Provider Lifecycle', () => {
    it('creates, gets, and deletes OAuth2 provider', async () => {
      const createCommand = new CreateOauth2CredentialProviderCommand({
        name: testOAuth2ProviderName,
        credentialProviderVendor: 'CustomOauth2',
        oauth2ProviderConfigInput: {
          customOauth2ProviderConfig: {
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            oauthDiscovery: {
              discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
            },
          },
        },
      });
      const created = await controlPlaneClient.send(createCommand);
      
      expect(created).toMatchObject({
        name: testOAuth2ProviderName,
        credentialProviderArn: expect.any(String),
        callbackUrl: expect.any(String),
      });

      const getCommand = new GetOauth2CredentialProviderCommand({ name: testOAuth2ProviderName });
      const retrieved = await controlPlaneClient.send(getCommand);
      expect(retrieved).toMatchObject({
        name: testOAuth2ProviderName,
        credentialProviderArn: created.credentialProviderArn,
        callbackUrl: expect.any(String),
      });

      const deleteCommand = new DeleteOauth2CredentialProviderCommand({ name: testOAuth2ProviderName });
      await controlPlaneClient.send(deleteCommand);
      
      await expect(
        controlPlaneClient.send(new GetOauth2CredentialProviderCommand({ name: testOAuth2ProviderName }))
      ).rejects.toThrow();
    }, 30000);
  });

  describe('API Key Provider Lifecycle', () => {
    it('creates, gets, and deletes API key provider', async () => {
      const createCommand = new CreateApiKeyCredentialProviderCommand({
        name: testApiKeyProviderName,
        apiKey: 'sk-test-key-123456789',
      });
      const created = await controlPlaneClient.send(createCommand);
      
      expect(created).toMatchObject({
        name: testApiKeyProviderName,
        credentialProviderArn: expect.any(String),
      });

      const getCommand = new GetApiKeyCredentialProviderCommand({ name: testApiKeyProviderName });
      const retrieved = await controlPlaneClient.send(getCommand);
      expect(retrieved).toMatchObject({
        name: testApiKeyProviderName,
        credentialProviderArn: created.credentialProviderArn,
      });

      const deleteCommand = new DeleteApiKeyCredentialProviderCommand({ name: testApiKeyProviderName });
      await controlPlaneClient.send(deleteCommand);
      
      await expect(
        controlPlaneClient.send(new GetApiKeyCredentialProviderCommand({ name: testApiKeyProviderName }))
      ).rejects.toThrow();
    }, 30000);
  });

  describe('HOF Wrappers', () => {
    it('wraps function with withAccessToken', async () => {
      // Set region for wrapper's internal IdentityClient
      process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
      
      const wrappedFn = withAccessToken<[string], { input: string; tokenLength: number }>({
        workloadIdentityToken: 'test-workload-token',
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'M2M',
      })(async (input: string, token: string) => {
        return { input, tokenLength: token.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });

    it('wraps function with withApiKey', async () => {
      // Set region for wrapper's internal IdentityClient
      process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
      
      const wrappedFn = withApiKey<[string], { input: string; keyLength: number }>({
        workloadIdentityToken: 'test-workload-token',
        providerName: 'test-provider',
      })(async (input: string, apiKey: string) => {
        return { input, keyLength: apiKey.length };
      });

      expect(wrappedFn).toBeDefined();
      expect(typeof wrappedFn).toBe('function');
    });
  });

  describe('M2M OAuth2 Token Retrieval (Full Flow)', { timeout: 60000 }, () => {
    it('completes full M2M flow with Cognito', async () => {
      // This test requires AWS Cognito permissions
      const { 
        CognitoIdentityProviderClient, 
        ListUserPoolsCommand,
        CreateUserPoolCommand, 
        CreateResourceServerCommand, 
        CreateUserPoolClientCommand, 
        CreateUserPoolDomainCommand,
        DescribeUserPoolClientCommand,
        ListUserPoolClientsCommand,
      } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const region = process.env.AWS_REGION || 'us-west-2';
      const cognito = new CognitoIdentityProviderClient({ region });
      const poolName = 'AgentCoreSDKIntegTest';
      const domainPrefix = 'agentcore-sdk-integ';
      
      // Check if pool already exists
      const listResponse = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60 }));
      let existingPool = listResponse.UserPools?.find(p => p.Name === poolName);
      
      let userPoolId: string;
      let clientId: string;
      let clientSecret: string;

      if (existingPool) {
        // Reuse existing pool
        userPoolId = existingPool.Id!;
        
        const clientsResponse = await cognito.send(new ListUserPoolClientsCommand({ 
          UserPoolId: userPoolId,
          MaxResults: 10,
        }));
        const existingClient = clientsResponse.UserPoolClients?.[0];
        
        if (existingClient) {
          const clientDetails = await cognito.send(new DescribeUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientId: existingClient.ClientId!,
          }));
          clientId = existingClient.ClientId!;
          clientSecret = clientDetails.UserPoolClient!.ClientSecret!;
        } else {
          // Create new client for existing pool
          const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientName: 'M2MTestClient',
            GenerateSecret: true,
            AllowedOAuthFlows: ['client_credentials'],
            AllowedOAuthScopes: ['test-api/read'],
            AllowedOAuthFlowsUserPoolClient: true,
          }));
          clientId = clientResponse.UserPoolClient!.ClientId!;
          clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
        }
      } else {
        // Create new pool
        const poolResponse = await cognito.send(new CreateUserPoolCommand({
          PoolName: poolName,
        }));
        userPoolId = poolResponse.UserPool!.Id!;

        await cognito.send(new CreateUserPoolDomainCommand({
          Domain: domainPrefix,
          UserPoolId: userPoolId,
        }));

        // Wait for domain to become active
        await new Promise(resolve => setTimeout(resolve, 5000));

        await cognito.send(new CreateResourceServerCommand({
          UserPoolId: userPoolId,
          Identifier: 'test-api',
          Name: 'Test API',
          Scopes: [{ ScopeName: 'read', ScopeDescription: 'Read access' }],
        }));

        const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientName: 'M2MTestClient',
          GenerateSecret: true,
          AllowedOAuthFlows: ['client_credentials'],
          AllowedOAuthScopes: ['test-api/read'],
          AllowedOAuthFlowsUserPoolClient: true,
        }));
        clientId = clientResponse.UserPoolClient!.ClientId!;
        clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
      }

      // Create AgentCore Identity OAuth2 provider
      const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
      const providerName = `test-m2m-provider-${Date.now()}`;
      const workloadName = `test-m2m-workload-${Date.now()}`;
      
      try {
        const createProviderCommand = new CreateOauth2CredentialProviderCommand({
          name: providerName,
          credentialProviderVendor: 'CustomOauth2',
          oauth2ProviderConfigInput: {
            customOauth2ProviderConfig: {
              clientId,
              clientSecret,
              oauthDiscovery: { discoveryUrl },
            },
          },
        });
        await controlPlaneClient.send(createProviderCommand);

        const createIdentityCommand = new CreateWorkloadIdentityCommand({ name: workloadName });
        await controlPlaneClient.send(createIdentityCommand);
        
        const getTokenCommand = new GetWorkloadAccessTokenForUserIdCommand({
          workloadName,
          userId: 'test-user',
        });
        const tokenResponse = await dataPlaneClient.send(getTokenCommand);
        const workloadToken = tokenResponse.workloadAccessToken!;

        const token = await client.getOAuth2Token({
          providerName,
          scopes: ['test-api/read'],
          authFlow: 'M2M',
          workloadIdentityToken: workloadToken,
        });

        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(0);
      } finally {
        // Cleanup AgentCore resources only (not Cognito pool)
        try { 
          await controlPlaneClient.send(new DeleteOauth2CredentialProviderCommand({ name: providerName }));
        } catch {}
        try { 
          await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: workloadName }));
        } catch {}
      }
    });
  });

  describe('Error Scenarios', () => {
    it('throws error when getting non-existent workload identity', async () => {
      await expect(
        controlPlaneClient.send(new GetWorkloadIdentityCommand({ name: 'non-existent-identity-12345' }))
      ).rejects.toThrow();
    });

    it('throws error when getting non-existent OAuth2 provider', async () => {
      await expect(
        controlPlaneClient.send(new GetOauth2CredentialProviderCommand({ name: 'non-existent-provider-12345' }))
      ).rejects.toThrow();
    });

    it('throws error when getting non-existent API key provider', async () => {
      await expect(
        controlPlaneClient.send(new GetApiKeyCredentialProviderCommand({ name: 'non-existent-provider-12345' }))
      ).rejects.toThrow();
    });

    it('throws error when deleting non-existent workload identity', async () => {
      await expect(
        controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: 'non-existent-identity-12345' }))
      ).rejects.toThrow();
    });

    it('throws error for OAuth2 token without workload token', async () => {
      await expect(
        client.getOAuth2Token({
          providerName: 'any-provider',
          scopes: ['read'],
          authFlow: 'M2M',
          workloadIdentityToken: 'invalid-token-12345',
        })
      ).rejects.toThrow();
    });

    it('throws error for API key without workload token', async () => {
      await expect(
        client.getApiKey({
          providerName: 'any-provider',
          workloadIdentityToken: 'invalid-token-12345',
        })
      ).rejects.toThrow();
    });
  });

  describe('Concurrent Request Tests', { timeout: 90000 }, () => {
    it('handles concurrent OAuth2 token requests', async () => {
      const { 
        CognitoIdentityProviderClient, 
        ListUserPoolsCommand,
        CreateUserPoolCommand, 
        CreateResourceServerCommand, 
        CreateUserPoolClientCommand, 
        CreateUserPoolDomainCommand,
        DescribeUserPoolClientCommand,
        ListUserPoolClientsCommand,
      } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const region = process.env.AWS_REGION || 'us-west-2';
      const cognito = new CognitoIdentityProviderClient({ region });
      const poolName = 'AgentCoreSDKIntegTest';
      const domainPrefix = 'agentcore-sdk-integ';
      
      // Check if pool already exists
      const listResponse = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60 }));
      let existingPool = listResponse.UserPools?.find(p => p.Name === poolName);
      
      let userPoolId: string;
      let clientId: string;
      let clientSecret: string;

      if (existingPool) {
        // Reuse existing pool
        userPoolId = existingPool.Id!;
        
        const clientsResponse = await cognito.send(new ListUserPoolClientsCommand({ 
          UserPoolId: userPoolId,
          MaxResults: 10,
        }));
        const existingClient = clientsResponse.UserPoolClients?.[0];
        
        if (existingClient) {
          const clientDetails = await cognito.send(new DescribeUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientId: existingClient.ClientId!,
          }));
          clientId = existingClient.ClientId!;
          clientSecret = clientDetails.UserPoolClient!.ClientSecret!;
        } else {
          const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
            UserPoolId: userPoolId,
            ClientName: 'ConcurrentTestClient',
            GenerateSecret: true,
            AllowedOAuthFlows: ['client_credentials'],
            AllowedOAuthScopes: ['test-api/read'],
            AllowedOAuthFlowsUserPoolClient: true,
          }));
          clientId = clientResponse.UserPoolClient!.ClientId!;
          clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
        }
      } else {
        // Create new pool
        const poolResponse = await cognito.send(new CreateUserPoolCommand({
          PoolName: poolName,
        }));
        userPoolId = poolResponse.UserPool!.Id!;

        await cognito.send(new CreateUserPoolDomainCommand({
          Domain: domainPrefix,
          UserPoolId: userPoolId,
        }));

        await new Promise(resolve => setTimeout(resolve, 5000));

        await cognito.send(new CreateResourceServerCommand({
          UserPoolId: userPoolId,
          Identifier: 'test-api',
          Name: 'Test API',
          Scopes: [{ ScopeName: 'read', ScopeDescription: 'Read access' }],
        }));

        const clientResponse = await cognito.send(new CreateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientName: 'ConcurrentTestClient',
          GenerateSecret: true,
          AllowedOAuthFlows: ['client_credentials'],
          AllowedOAuthScopes: ['test-api/read'],
          AllowedOAuthFlowsUserPoolClient: true,
        }));
        clientId = clientResponse.UserPoolClient!.ClientId!;
        clientSecret = clientResponse.UserPoolClient!.ClientSecret!;
      }

      const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
      const providerName = `concurrent-provider-${Date.now()}`;
      const workloadName = `concurrent-workload-${Date.now()}`;

      try {
        const createProviderCommand = new CreateOauth2CredentialProviderCommand({
          name: providerName,
          credentialProviderVendor: 'CustomOauth2',
          oauth2ProviderConfigInput: {
            customOauth2ProviderConfig: {
              clientId,
              clientSecret,
              oauthDiscovery: { discoveryUrl },
            },
          },
        });
        await controlPlaneClient.send(createProviderCommand);

        const createIdentityCommand = new CreateWorkloadIdentityCommand({ name: workloadName });
        await controlPlaneClient.send(createIdentityCommand);
        
        const getTokenCommand = new GetWorkloadAccessTokenForUserIdCommand({
          workloadName,
          userId: 'test-user',
        });
        const tokenResponse = await dataPlaneClient.send(getTokenCommand);
        const workloadToken = tokenResponse.workloadAccessToken!;

        // Make 5 concurrent token requests
        const numRequests = 5;
        const promises = [];

        for (let i = 0; i < numRequests; i++) {
          promises.push(
            client.getOAuth2Token({
              providerName,
              scopes: ['test-api/read'],
              authFlow: 'M2M',
              workloadIdentityToken: workloadToken,
            })
          );
        }

        const tokens = await Promise.all(promises);

        expect(tokens).toHaveLength(numRequests);
        tokens.forEach(token => {
          expect(token).toBeDefined();
          expect(typeof token).toBe('string');
          expect(token.length).toBeGreaterThan(0);
        });
      } finally {
        // Cleanup AgentCore resources only (not Cognito pool)
        try { 
          await controlPlaneClient.send(new DeleteOauth2CredentialProviderCommand({ name: providerName }));
        } catch {}
        try { 
          await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: workloadName }));
        } catch {}
      }
    });

    it('handles concurrent API key requests', async () => {
      const testSuffix = Date.now();
      const providerName = `concurrent-apikey-${testSuffix}`;
      const workloadName = `concurrent-apikey-workload-${testSuffix}`;

      try {
        // Setup
        const createProviderCommand = new CreateApiKeyCredentialProviderCommand({
          name: providerName,
          apiKey: 'sk-concurrent-test-key',
        });
        await controlPlaneClient.send(createProviderCommand);

        const createIdentityCommand = new CreateWorkloadIdentityCommand({ name: workloadName });
        await controlPlaneClient.send(createIdentityCommand);
        
        const getTokenCommand = new GetWorkloadAccessTokenForUserIdCommand({
          workloadName,
          userId: 'test-user',
        });
        const tokenResponse = await dataPlaneClient.send(getTokenCommand);
        const workloadToken = tokenResponse.workloadAccessToken!;

        // Make 5 concurrent API key requests
        const numRequests = 5;
        const promises = [];

        for (let i = 0; i < numRequests; i++) {
          promises.push(
            client.getApiKey({
              providerName,
              workloadIdentityToken: workloadToken,
            })
          );
        }

        const apiKeys = await Promise.all(promises);

        // Verify all requests succeeded
        expect(apiKeys).toHaveLength(numRequests);
        apiKeys.forEach(apiKey => {
          expect(apiKey).toBeDefined();
          expect(typeof apiKey).toBe('string');
          expect(apiKey).toBe('sk-concurrent-test-key');
        });

        // Cleanup
        await controlPlaneClient.send(new DeleteApiKeyCredentialProviderCommand({ name: providerName }));
        await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: workloadName }));
      } catch (e) {
        // Cleanup on error
        try {
          await controlPlaneClient.send(new DeleteApiKeyCredentialProviderCommand({ name: providerName }));
        } catch {}
        try {
          await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: workloadName }));
        } catch {}
        throw e;
      }
    });

    it('handles concurrent workload token requests', async () => {
      const testSuffix = Date.now();
      const workloadName = `concurrent-token-workload-${testSuffix}`;

      try {
        const createCommand = new CreateWorkloadIdentityCommand({ name: workloadName });
        await controlPlaneClient.send(createCommand);

        // Make 5 concurrent workload token requests
        const numRequests = 5;
        const promises = [];

        for (let i = 0; i < numRequests; i++) {
          promises.push(
            dataPlaneClient.send(new GetWorkloadAccessTokenForUserIdCommand({
              workloadName,
              userId: `user-${i}`,
            }))
          );
        }

        const responses = await Promise.all(promises);

        // Verify all requests succeeded
        expect(responses).toHaveLength(numRequests);
        responses.forEach(response => {
          expect(response.workloadAccessToken).toBeDefined();
          expect(typeof response.workloadAccessToken).toBe('string');
          expect(response.workloadAccessToken!.length).toBeGreaterThan(0);
        });

        // Cleanup
        await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: workloadName }));
      } catch (e) {
        try {
          await controlPlaneClient.send(new DeleteWorkloadIdentityCommand({ name: workloadName }));
        } catch {}
        throw e;
      }
    });
  });
});
