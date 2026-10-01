using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SaaS.Search;
using Xunit;

public class SearchIndexServiceTests
{
    private readonly SearchIndexService _service = new SearchIndexService();

    [Fact]
    public async Task IndexUser_ThenSearch_FindsDocument()
    {
        var indexReq = new IndexRequest
        {
            DocumentType = "user",
            DocumentId = "123",
            Content = "john doe john@example.com team member active",
            Metadata = new Dictionary<string, object>
            {
                {"user_id", 123},
                {"email", "john@example.com"},
                {"tier", "team"},
                {"status", "active"},
                {"created_at", "2026-01-15T00:00:00Z"}
            }
        };
        var idxResp = await _service.IndexDocumentAsync(indexReq);
        Assert.True(idxResp.Success);

        var searchReq = new SearchRequest
        {
            Query = "john",
            DocumentType = "user",
            Limit = 20,
            Offset = 0
        };
        var resp = await _service.SearchAsync(searchReq);
        Assert.Single(resp.Results);
        var item = resp.Results[0];
        Assert.Equal("123", item.DocumentId);
        Assert.Equal("user", item.DocumentType);
        Assert.True(item.Relevance > 0);
        Assert.Equal("john@example.com", item.Metadata["email"]);
        Assert.Equal("team", item.Metadata["tier"]);
        Assert.Equal("active", item.Metadata["status"]);
    }

    [Fact]
    public async Task IndexDeployment_SearchWithFilters_ReturnsCorrect()
    {
        // Index two deployments
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "deployment",
            DocumentId = "d1",
            Content = "stripe integration for team",
            Metadata = new Dictionary<string, object>
            {
                {"tier", "team"},
                {"status", "active"}
            }
        });
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "deployment",
            DocumentId = "d2",
            Content = "stripe integration for solo",
            Metadata = new Dictionary<string, object>
            {
                {"tier", "solo"},
                {"status", "draft"}
            }
        });

        var searchReq = new SearchRequest
        {
            Query = "stripe",
            DocumentType = "deployment",
            Filters = new List<string> { "tier:team", "status:active" },
            Limit = 20
        };
        var resp = await _service.SearchAsync(searchReq);
        Assert.Single(resp.Results);
        Assert.Equal("d1", resp.Results[0].DocumentId);
    }

    [Fact]
    public async Task PartialMatch_FindsDocument()
    {
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "deployment",
            DocumentId = "d3",
            Content = "stripe payment gateway",
            Metadata = new Dictionary<string, object>()
        });

        var searchReq = new SearchRequest
        {
            Query = "stri",
            DocumentType = "deployment"
        };
        var resp = await _service.SearchAsync(searchReq);
        Assert.Single(resp.Results);
        Assert.Equal("d3", resp.Results[0].DocumentId);
    }

    [Fact]
    public async Task Facets_ReturnCountsPerStatus()
    {
        // Ensure some docs with various statuses
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "deployment",
            DocumentId = "d4",
            Content = "alpha",
            Metadata = new Dictionary<string, object> { {"status", "active"} }
        });
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "deployment",
            DocumentId = "d5",
            Content = "beta",
            Metadata = new Dictionary<string, object> { {"status", "draft"} }
        });
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "deployment",
            DocumentId = "d6",
            Content = "gamma",
            Metadata = new Dictionary<string, object> { {"status", "active"} }
        });

        var searchReq = new SearchRequest
        {
            Query = "deployment",
            DocumentType = "deployment",
            Facets = new List<string> { "status" }
        };
        var resp = await _service.SearchAsync(searchReq);
        Assert.NotNull(resp.Facets);
        Assert.True(resp.Facets.ContainsKey("status"));
        var statusCounts = resp.Facets["status"];
        Assert.Equal(2, statusCounts["active"]);
        Assert.Equal(1, statusCounts["draft"]);
    }

    [Fact]
    public async Task Unindex_RemovesDocument()
    {
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "user",
            DocumentId = "999",
            Content = "temp user",
            Metadata = new Dictionary<string, object>()
        });

        var before = await _service.SearchAsync(new SearchRequest
        {
            Query = "temp",
            DocumentType = "user"
        });
        Assert.Single(before.Results);

        var unidxResp = await _service.UnindexDocumentAsync("user", "999");
        Assert.True(unidxResp.Success);

        var after = await _service.SearchAsync(new SearchRequest
        {
            Query = "temp",
            DocumentType = "user"
        });
        Assert.Empty(after.Results);
    }

    [Fact]
    public async Task Reindex_AllTypes_EnqueuesJob()
    {
        var resp = await _service.ReindexAsync(new ReindexRequest { DocumentType = null });
        Assert.True(resp.Success);
        Assert.False(string.IsNullOrWhiteSpace(resp.JobId));
        Assert.Equal("enqueued", resp.Status);
    }

    [Fact]
    public async Task RealTime_Indexing_Within100ms()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "user",
            DocumentId = "rt1",
            Content = "real time test",
            Metadata = new Dictionary<string, object>()
        });
        var resp = await _service.SearchAsync(new SearchRequest
        {
            Query = "real",
            DocumentType = "user"
        });
        sw.Stop();
        Assert.Single(resp.Results);
        Assert.True(sw.ElapsedMilliseconds <= 100, $"Elapsed {sw.ElapsedMilliseconds}ms > 100ms");
    }

    [Fact]
    public async Task Relevance_ExactMatchHigherThanPartial()
    {
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "doc",
            DocumentId = "ex1",
            Content = "stripe integration",
            Metadata = new Dictionary<string, object>()
        });
        await _service.IndexDocumentAsync(new IndexRequest
        {
            DocumentType = "doc",
            DocumentId = "ex2",
            Content = "stri payment",
            Metadata = new Dictionary<string, object>()
        });

        var resp = await _service.SearchAsync(new SearchRequest
        {
            Query = "stripe",
            DocumentType = "doc"
        });
        Assert.Equal(2, resp.Results.Count);
        Assert.Equal("ex1", resp.Results[0].DocumentId); // exact higher relevance
    }
}