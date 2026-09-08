namespace ChatServer.Services;

/// <summary>
/// Sabe quais réplicas estão vivas AGORA, e limpa a presença das que morreram.
///
/// Existe por causa de um problema concreto: quando um processo do backend cai
/// de repente, ele não roda OnDisconnectedAsync, então a presença de quem
/// estava nele fica registrada no Redis sem nenhuma conexão por trás. Isso
/// causava duas coisas ruins. A pessoa aparecia para sempre no visualizador
/// como se estivesse online (o prazo de validade da chave de presença não
/// resolve, porque ele é renovado a cada entrada e saída na sala, então numa
/// sala com movimento nunca expira). E, pior, a reconexão automática dela era
/// recusada com "esse nome já está em uso", porque a checagem de nome único
/// encontrava o próprio registro órfão: derrubar uma réplica expulsava quem
/// estava nela em vez de migrá-la.
///
/// A ideia é simples: cada réplica avisa periodicamente que está viva, com um
/// prazo curto. Quem não avisa há alguns segundos é considerada morta, e a
/// presença dela é apagada.
/// </summary>
public interface IReplicaRegistry
{
    /// <summary>Avisa que esta réplica está viva. Chamado em intervalos curtos.</summary>
    Task HeartbeatAsync(string replicaName);

    /// <summary>Filtra, entre as réplicas informadas, as que avisaram recentemente.</summary>
    Task<IReadOnlyList<string>> GetAliveAsync(IEnumerable<string> replicaNames);

    /// <summary>
    /// Apaga a presença de uma réplica morta e desconta essas pessoas da sala
    /// informada. Devolve quem foi removido, pra quem chamou poder avisar os
    /// clientes conectados. É seguro rodar em várias réplicas ao mesmo tempo:
    /// a primeira que rodar leva os nomes, as outras recebem lista vazia.
    /// </summary>
    Task<IReadOnlyList<string>> ReapAsync(string deadReplicaName, string roomName);
}
