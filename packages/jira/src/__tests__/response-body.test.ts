import { getResponseBody } from '../jira-client/core/request.js';

function jsonResponse(status: number, body: string): Response {
  return {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe('getResponseBody', () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    errorSpy.mockClear();
  });

  afterAll(() => {
    errorSpy.mockRestore();
  });

  it('returns undefined for an empty JSON body without logging (e.g. POST /issueLink)', async () => {
    const result = await getResponseBody(jsonResponse(201, ''));

    expect(result).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('parses a non-empty JSON body', async () => {
    const result = await getResponseBody(jsonResponse(200, '{"id":"1158012"}'));

    expect(result).toEqual({ id: '1158012' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns undefined for a 204 No Content response (e.g. DELETE /issueLink)', async () => {
    const result = await getResponseBody(jsonResponse(204, ''));

    expect(result).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
