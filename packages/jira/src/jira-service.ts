import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { downloadAttachment, handleApiOperation, resolveOpenApiBase, type AttachmentDownloadOptions } from '@atlassian-dc-mcp/common';
import { AttachmentService, IssueService, MyselfService, OpenAPI, SearchService } from './jira-client/index.js';
import { request as __request } from './jira-client/core/request.js';
import type { StringList } from './jira-client/models/StringList.js';
import { getDefaultPageSize, getMissingConfig, JIRA_PRODUCT } from './config.js';

const DEFAULT_SEARCH_FIELDS = ['summary', 'description', 'status', 'assignee', 'reporter', 'priority', 'issuetype', 'labels', 'updated'];
const DEFAULT_ISSUE_FIELDS = [...DEFAULT_SEARCH_FIELDS, 'parent', 'subtasks'];

type DevelopmentDataType = 'pullrequest' | 'repository' | 'branch';
type DevelopmentApplicationType = 'stash' | 'bitbucket' | 'github' | 'githube';

function toIssueFieldSelection(fields: string[]): Array<StringList> {
  // The generated client types this query param as StringList[], but the API expects repeated string field names.
  return fields as unknown as Array<StringList>;
}

function resolveToken(token: string | (() => string | undefined), missingTokenMessage: string) {
  return async () => {
    const resolvedToken = typeof token === 'function' ? token() : token;
    if (!resolvedToken) {
      throw new Error(missingTokenMessage);
    }
    return resolvedToken;
  };
}

export class JiraService {
  private readonly getPageSize: () => number;
  private readonly tokenProvider: string | (() => string | undefined);

  constructor(
    host: string | undefined,
    token: string | (() => string | undefined),
    apiBasePath?: string,
    getPageSize: () => number = getDefaultPageSize,
  ) {
    OpenAPI.BASE = resolveOpenApiBase({
      host,
      apiBasePath,
      defaultBasePath: JIRA_PRODUCT.defaultApiBasePath ?? '/rest',
      strippableSuffixes: JIRA_PRODUCT.apiBasePathStrippableSuffixes,
    });
    OpenAPI.TOKEN = resolveToken(token, 'Missing required environment variable: JIRA_API_TOKEN');
    OpenAPI.VERSION = '2';
    OpenAPI.HEADERS = { 'X-Atlassian-Token': 'no-check' };
    this.tokenProvider = token;
    this.getPageSize = getPageSize;
  }

  async searchIssues(jql: string, startAt?: number, expand?: string[], maxResults?: number, fields?: string[]) {
    return handleApiOperation(() => {
      return SearchService.searchUsingSearchRequest({
        jql,
        maxResults: maxResults ?? this.getPageSize(),
        fields: fields ?? DEFAULT_SEARCH_FIELDS,
        expand,
        startAt
      });
    }, 'Error searching issues');
  }

  async getIssue(issueKey: string, expand?: string, fields?: string[]) {
    return handleApiOperation(
      () => IssueService.getIssue(issueKey, expand, toIssueFieldSelection(fields ?? DEFAULT_ISSUE_FIELDS)),
      'Error getting issue'
    );
  }

  async getIssueComments(issueKey: string, expand?: string, maxResults?: number, startAt?: number) {
    return handleApiOperation(
      () => IssueService.getComments(issueKey, expand, (maxResults ?? this.getPageSize()).toString(), undefined, startAt?.toString()),
      'Error getting issue comments'
    );
  }

  async postIssueComment(issueKey: string, comment: string) {
    return handleApiOperation(() => IssueService.addComment(issueKey, undefined, { body: comment }), 'Error posting issue comment');
  }

  async createIssue(params: {
    projectId: string;
    summary: string;
    description: string;
    issueTypeId: string;
    customFields?: Record<string, any>;
  }) {
    return handleApiOperation(async () => {
      const standardFields = {
        project: { key: params.projectId },
        summary: params.summary,
        description: params.description,
        issuetype: { id: params.issueTypeId }
      };

      const fields = params.customFields
        ? { ...standardFields, ...params.customFields }
        : standardFields;

      return IssueService.createIssue(true, { fields });
    }, 'Error creating issue');
  }

  async updateIssue(params: {
    issueKey: string;
    summary?: string;
    description?: string;
    issueTypeId?: string;
    customFields?: Record<string, any>;
  }) {
    return handleApiOperation(async () => {
      const standardFields: Record<string, any> = {};
      if (params.summary !== undefined) {
        standardFields.summary = params.summary;
      }
      if (params.description !== undefined) {
        standardFields.description = params.description;
      }
      if (params.issueTypeId !== undefined) {
        standardFields.issuetype = { id: params.issueTypeId };
      }

      const fields = params.customFields
        ? { ...standardFields, ...params.customFields }
        : standardFields;

      return IssueService.editIssue(params.issueKey, 'true', { fields });
    }, 'Error updating issue');
  }

  async getTransitions(issueKey: string) {
    return handleApiOperation(
      () => IssueService.getTransitions(issueKey),
      'Error getting transitions'
    );
  }

  async getIssueDevelopmentInfo(
    issueKey: string,
    dataType: DevelopmentDataType = 'pullrequest',
    applicationType: DevelopmentApplicationType = 'stash',
  ) {
    return handleApiOperation(async () => {
      const issueId = await this.resolveIssueId(issueKey);
      return __request(OpenAPI, {
        method: 'GET',
        url: '/dev-status/1.0/issue/detail',
        query: { issueId, applicationType, dataType },
      });
    }, 'Error getting issue development info');
  }

  private async resolveIssueId(issueKey: string): Promise<string> {
    // The dev-status API is keyed by the numeric issue id, not the issue key.
    const issue = await IssueService.getIssue(issueKey, undefined, toIssueFieldSelection(['id']));
    if (!issue?.id) {
      throw new Error(`Could not resolve numeric id for issue ${issueKey}`);
    }
    return issue.id;
  }

  async transitionIssue(params: {
    issueKey: string;
    transitionId: string;
    fields?: Record<string, any>;
    customFields?: Record<string, any>;
  }) {
    return handleApiOperation(async () => {
      const requestBody: { transition: { id: string }; fields?: Record<string, any> } = {
        transition: { id: params.transitionId }
      };
      if (params.fields) {
        requestBody.fields = params.fields;
      }
      if (params.customFields) {
        Object.assign(requestBody, params.customFields);
      }
      return IssueService.doTransition(params.issueKey, requestBody);
    }, 'Error transitioning issue');
  }

  async uploadAttachment(issueKey: string, filePath: string, filename?: string) {
    const buffer = await readFile(filePath);
    const name = filename || basename(filePath);
    const file = new File([buffer], name);
    // IssueService types formData as Blob, but the API expects { file } — getFormData handles File via isBlob()
    return handleApiOperation(
      () => IssueService.addAttachment(issueKey, { file } as any),
      'Error uploading attachment',
    );
  }

  /**
   * Download attachments from a JIRA issue, or a single attachment by its id.
   * Exactly one of `attachmentId` or `issueKey` must be provided.
   * @param params.attachmentId Download a single attachment by its numeric id
   * @param params.issueKey Download attachments from this issue (optionally filtered by filename)
   * @param params.filename When using issueKey, download only attachments with this exact filename
   * @param params.options Save-to-disk and inline-content options (see AttachmentDownloadOptions)
   */
  async downloadAttachments(params: {
    attachmentId?: string;
    issueKey?: string;
    filename?: string;
    options?: AttachmentDownloadOptions;
  }) {
    return handleApiOperation(async () => {
      const beans = await this.resolveAttachmentBeans(params);
      const attachments = [];
      for (const bean of beans) {
        const url = bean?.content;
        if (!url) {
          throw new Error(`Attachment "${bean?.filename ?? bean?.id}" has no download URL`);
        }
        attachments.push(
          await downloadAttachment({
            url,
            token: this.tokenProvider,
            filename: bean?.filename ?? String(bean?.id ?? 'attachment'),
            mediaType: bean?.mimeType,
            options: params.options,
          }),
        );
      }
      return { count: attachments.length, attachments };
    }, 'Error downloading attachment');
  }

  private async resolveAttachmentBeans(params: {
    attachmentId?: string;
    issueKey?: string;
    filename?: string;
  }): Promise<Array<Record<string, any>>> {
    if (params.attachmentId) {
      const bean = await AttachmentService.getAttachment(params.attachmentId);
      return [bean as Record<string, any>];
    }
    if (!params.issueKey) {
      throw new Error('Either attachmentId or issueKey must be provided');
    }
    const issue = await IssueService.getIssue(params.issueKey, undefined, toIssueFieldSelection(['attachment']));
    const all = (((issue as any)?.fields?.attachment) ?? []) as Array<Record<string, any>>;
    const filtered = params.filename ? all.filter((a) => a?.filename === params.filename) : all;
    if (filtered.length === 0) {
      throw new Error(
        params.filename
          ? `No attachment named "${params.filename}" found on issue ${params.issueKey}`
          : `No attachments found on issue ${params.issueKey}`,
      );
    }
    return filtered;
  }

  async validateSetup(): Promise<void> {
    await MyselfService.getUser();
  }

  static validateConfig(): string[] {
    return getMissingConfig();
  }
}

export const jiraToolSchemas = {
  searchIssues: {
    jql: z.string().describe("JQL query string"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
    startAt: z.number().optional().describe("Index of the first result to return"),
    expand: z.array(z.string()).optional().describe("Additional sections to expand in the search response, such as renderedFields, names, or schema"),
    fields: z.array(z.string()).optional().describe("Issue field names to include in the response. When omitted, a moderate-detail default field set is used.")
  },
  getIssue: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    expand: z.string().optional().describe("Comma-separated response sections to expand, such as renderedFields, changelog, or transitions"),
    fields: z.array(z.string()).optional().describe("Issue field names to include in the response. When omitted, a moderate-detail default field set is used.")
  },
  getIssueComments: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    expand: z.string().optional().describe("Comma-separated comment expansions, such as renderedBody"),
    maxResults: z.number().optional().describe("Maximum number of comments to return"),
    startAt: z.number().optional().describe("Index of the first comment to return")
  },
  postIssueComment: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    comment: z.string().describe("Comment text in the format suitable for JIRA DATA CENTER edition (JIRA Wiki Markup).")
  },
  createIssue: {
    projectId: z.string().describe("Project key (despite the parameter name, e.g. TEST)"),
    summary: z.string().describe("Issue summary"),
    description: z.string().describe("Issue description in the format suitable for JIRA DATA CENTER edition (JIRA Wiki Markup)."),
    issueTypeId: z.string().describe("Issue type id (e.g. id of Task, Bug, Story). Should be found first a correct number for specific JIRA installation."),
    customFields: z.record(z.any()).optional().describe("Optional fields merged into the JIRA create payload. Can be used for custom fields and standard fields such as labels. Examples: {'customfield_10001': 'Custom Value', 'priority': {'id': '1'}, 'assignee': {'name': 'john.doe'}, 'labels': ['urgent', 'bug']}")
  },
  updateIssue: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    summary: z.string().optional().describe("New summary (optional)"),
    description: z.string().optional().describe("New description in JIRA Wiki Markup (optional)"),
    issueTypeId: z.string().optional().describe("New issue type id (optional)"),
    customFields: z.record(z.any()).optional().describe("Optional fields merged into the JIRA update payload. Can be used for custom fields and standard fields such as labels. Examples: {'customfield_10001': 'Custom Value', 'priority': {'id': '1'}, 'assignee': {'name': 'john.doe'}, 'labels': ['urgent', 'bug']}")
  },
  getTransitions: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)")
  },
  getIssueDevelopmentInfo: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    dataType: z.enum(['pullrequest', 'repository', 'branch']).optional().describe("Development data to fetch: 'pullrequest' (default), 'repository' (commits), or 'branch'"),
    applicationType: z.enum(['stash', 'bitbucket', 'github', 'githube']).optional().describe("Linked SCM type: 'stash' (Bitbucket Server/Data Center, default), 'bitbucket' (Cloud), 'github', or 'githube' (GitHub Enterprise)")
  },
  transitionIssue: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    transitionId: z.string().describe("The ID of the transition to perform. Use jira_getTransitions to find available transitions and their IDs."),
    fields: z.record(z.any()).optional().describe("Optional fields required by the transition screen. Use jira_getTransitions to see which fields are available for each transition."),
    customFields: z.record(z.any()).optional().describe("Optional fields merged into the JIRA transition payload. Can be used for update operations such as comments. Example: {'update': {'comment': [{'add': {'body': 'text'}}]}}")
  },
  uploadAttachment: {
    issueKey: z.string().describe("JIRA issue key (e.g., PROJ-123)"),
    filePath: z.string().describe("Absolute local filesystem path of the file to upload"),
    filename: z.string().optional().describe("Override for the attachment filename (defaults to the basename of filePath)")
  },
  downloadAttachment: {
    issueKey: z.string().optional().describe("JIRA issue key (e.g., PROJ-123) whose attachment(s) to download. Provide either issueKey or attachmentId."),
    attachmentId: z.string().optional().describe("Numeric id of a single attachment to download. Provide either attachmentId or issueKey."),
    filename: z.string().optional().describe("When using issueKey, download only attachments with this exact filename. If omitted, all attachments on the issue are downloaded."),
    saveDir: z.string().optional().describe("Absolute local directory to save the attachment(s) into. The attachment filename is used as the file name. Preferred when downloading multiple files."),
    savePath: z.string().optional().describe("Absolute local file path to save a single attachment to. Overrides saveDir. Only meaningful when downloading a single attachment."),
    returnContent: z.enum(['none', 'base64', 'text']).optional().describe("Whether to embed the file bytes in the response: 'none' (default), 'base64' for binary, or 'text' for UTF-8 text. Combine with saveDir/savePath to also save to disk."),
    maxInlineBytes: z.number().optional().describe("Maximum bytes to embed inline when returnContent is base64/text. Larger files are saved (if a path is given) but not embedded. Defaults to 1 MiB.")
  }
};
